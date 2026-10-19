// server-only: shared helper that rebuilds the Managed Agent's tool surface
// and pushes it to Anthropic. Called by every mutation that touches the tool
// registry or the agent identity:
//   - /api/agent (identity save)
//   - /api/setup/agent (create / update during wizard)
//   - /api/tools (create / toggle / delete HTTP tools)
//
// On version mismatch (HTTP 409 / "version" in error message) the helper
// re-reads the current agent version and retries once. On any other failure it
// returns { synced: false, error } without throwing, so the CRUD response that
// triggered the sync is still returned to the client.

import { createServiceClient } from "@/lib/supabase/service";
import { configValues, configValuesFresh, setConfigValues } from "@/lib/runtime-config";
import type { ConfigWriter } from "@/lib/auth/scope-guard";
import type { AgentToolRow, ToolGateFlags } from "@/lib/agent-prompt";
import { renameAgentResource, retrieveAgent, updateAgent, type NamedResource } from "@/lib/anthropic-managed";
import { versionToRecordAfterRename } from "@/lib/agent-rename";
import { detectVoiceFiles } from "@/lib/voice-detect";
import type { AgentRetriever } from "@/lib/once-retriever";
import type { PromptConflict } from "@/lib/agent-prompt-sync";
import {
  PAYLOAD_CONFIG_KEYS,
  composeSyncPayload,
  conflictFor,
  runAgentSync,
  type Baseline,
  type ConflictResolution,
  type SyncPayload,
  type SyncResult,
} from "@/lib/agent-sync-core";

export type { ConflictResolution, SyncResult };
export { detectVoiceFiles };

type Payload = SyncPayload & { apiKey: string; agentId: string };

/**
 * Lee la línea base DIRECTO de la tabla (sin la memoización por request de configValues):
 * un sync concurrente, un rename o esta misma request pueden haberla movido, y una línea
 * base vieja produce falsos conflictos.
 */
async function readBaseline(): Promise<Baseline> {
  const cfg = await configValuesFresh(["AGENT_PROMPT_SYNCED_HASH", "ANTHROPIC_AGENT_VERSION"]);
  const reg = Number(cfg.ANTHROPIC_AGENT_VERSION);
  return {
    syncedHash: cfg.AGENT_PROMPT_SYNCED_HASH || undefined,
    registeredVersion: Number.isFinite(reg) && reg > 0 ? reg : null,
  };
}

/**
 * Renombra el agente en Anthropic y REGISTRA la versión que eso genera (un rename sube la
 * versión). Sin esto el siguiente sync vería «versión viva > registrada» y daría un falso
 * conflicto. Si el agente ya estaba por delante de lo registrado (edición externa) no se
 * registra: taparía ese conflicto real (ver agent-rename.versionToRecordAfterRename).
 */
export async function renameAgent(apiKey: string, agentId: string, name: string, writer: ConfigWriter): Promise<void> {
  const result = await renameAgentResource(apiKey, agentId, name);
  const { registeredVersion } = await readBaseline();
  const record = versionToRecordAfterRename({ registered: registeredVersion, result });
  if (record !== null) await setConfigValues({ ANTHROPIC_AGENT_VERSION: String(record) }, writer);
}

/**
 * Arma lo que se empujaría al agente (system compuesto + tools) desde la DB.
 * Devuelve `null` si el agente no está aprovisionado (no hay nada que sincronizar) o
 * `{ error }` ante un fallo de lectura (se aborta en vez de empujar una superficie
 * degradada).
 */
async function buildPayload(): Promise<Payload | null | { error: string }> {
  // 1. Resolve required config keys.
  const cfg = await configValues(PAYLOAD_CONFIG_KEYS);

  const apiKey = cfg.ANTHROPIC_API_KEY;
  const agentId = cfg.ANTHROPIC_AGENT_ID;

  // If the agent hasn't been provisioned yet, skip silently (the wizard will
  // create it with the correct tool surface later).
  if (!apiKey || !agentId) return null;

  // 2. Fetch all enabled tool rows (system + http) in the order they'll be
  //    rendered: toolset first (system rows ordered by name desc puts
  //    agent_toolset before search_kb), then http rows by created_at.
  const supabase = createServiceClient();
  const { data, error: fetchErr } = await supabase
    .from("agent_tools")
    .select("name, description, input_schema, tool_type")
    .eq("enabled", true)
    .order("tool_type", { ascending: false }) // 'system' > 'http'
    .order("created_at", { ascending: true });

  if (fetchErr) {
    console.error("syncAgentTools: failed to fetch agent_tools:", fetchErr.message);
    return { error: fetchErr.message };
  }

  // 2b. Fetch the action gates: gated-off system tools are NOT declared
  //     (their schema costs tokens every turn + invites hallucinated calls).
  //     select("*") keeps this tolerant to clones whose kommo_publish_config
  //     lacks newer gate columns. No row → only ungated tools (gates default
  //     false). A FETCH ERROR aborts the sync instead: pushing a surface with
  //     the CRM tools silently stripped on a transient DB error would leave
  //     the agent degraded until the next successful sync.
  const { data: gateRow, error: gateErr } = await supabase
    .from("kommo_publish_config")
    .select("*")
    .eq("is_active", true)
    .maybeSingle();

  if (gateErr) {
    console.error("syncAgentTools: failed to fetch kommo_publish_config:", gateErr.message);
    return { error: gateErr.message };
  }

  // 3. Voice step: si /voice/ está vacío en el master store, el scaffold omite ese paso.
  const hasVoice = await detectVoiceFiles(apiKey, cfg.ANTHROPIC_MEMORY_MASTER_ID);

  // 4. La composición (prompt del operador + CORE_SCAFFOLD, tools por compuertas, placeholders)
  //    vive en agent-sync-core: la usa también la CLI scripts/sync-agent.mjs.
  const composed = composeSyncPayload({
    cfg,
    toolRows: (data ?? []) as AgentToolRow[],
    gateRow: (gateRow ?? null) as ToolGateFlags | null,
    hasVoice,
    baseline: await readBaseline(),
  });
  return { ...composed, apiKey, agentId };
}

const conflictOf = (p: Payload, live: NamedResource, baseline: Baseline = p.baseline): PromptConflict | null =>
  conflictFor(p, live, baseline);

/**
 * ¿El prompt vivo fue modificado fuera del dashboard? Para los caminos que cambian el
 * agente SIN empujar el prompt (p. ej. cambiar el modelo en /consumo): suben la versión
 * del agente y, sin este chequeo, taparían la señal. null = sin conflicto (o agente
 * sin aprovisionar / Anthropic no responde: no se afirma lo que no se pudo comprobar).
 * `retrieve` es inyectable: una página que además necesita el agente vivo para otra cosa
 * pasa un retriever compartido (lib/once-retriever) y el agente se lee UNA vez por render.
 *
 * `opts.onlyWithBaseline`: ignora el caso «primera sincronización» (sin hash registrado). Para
 * caminos que NO empujan el prompt (cambiar el modelo): sin línea base no hay señal que
 * taparían, así que un cliente que recién actualiza no queda bloqueado sin necesidad.
 */
export async function checkAgentPromptConflict(
  retrieve: AgentRetriever = retrieveAgent,
  opts: { onlyWithBaseline?: boolean } = {}
): Promise<PromptConflict | null> {
  try {
    const payload = await buildPayload();
    if (!payload || "error" in payload) return null;
    const conflict = conflictOf(payload, await retrieve(payload.apiKey, payload.agentId));
    if (conflict && opts.onlyWithBaseline && conflict.kind === "first_sync_differs") return null;
    return conflict;
  } catch {
    return null;
  }
}

/**
 * Reads all enabled agent_tools rows from the DB, builds the Anthropic tools
 * array, substitutes system-prompt placeholders, and calls updateAgent with
 * optimistic concurrency. Returns the new version on success.
 *
 * ANTES de empujar compara el prompt vivo contra lo último sincronizado
 * (agent-prompt-sync.ts): si fue editado por fuera NO sincroniza y devuelve
 * `conflict`. `opts.resolve` es la decisión explícita del usuario:
 *   - "overwrite":   empuja el de la DB igual (pisa lo de afuera);
 *   - "import_live": no empuja; trae el prompt vivo del operador a la DB.
 *
 * @param writer  Quién sincroniza y con qué alcance (de requireScope): queda en
 *                runtime_config.updated_by y setConfigValues valida que pueda escribir.
 */
export async function syncAgentTools(
  writer: ConfigWriter,
  opts: {
    resolve?: ConflictResolution;
    /** Hash del system vivo que el operador VIO al elegir (PromptConflict.liveHash). Obligatorio con `resolve`. */
    expectedLiveHash?: string;
  } = {}
): Promise<SyncResult> {
  try {
    const payload = await buildPayload();
    if (!payload) return { version: null, synced: false };
    if ("error" in payload) return { version: null, synced: false, error: payload.error };
    const { apiKey, agentId } = payload;
    // Decisión y escritura: agent-sync-core.runAgentSync (compartida con la CLI).
    const res = await runAgentSync(
      {
        readBaseline,
        retrieve: () => retrieveAgent(apiKey, agentId),
        update: async (version, body) => {
          const updated = await updateAgent(apiKey, agentId, { version, ...body });
          return (updated.version as number) ?? 0;
        },
        writeConfig: (values) => setConfigValues(values, writer),
      },
      payload,
      opts
    );
    if (!res.synced && res.error && !res.conflict && !res.stale) console.error("syncAgentTools: updateAgent failed:", res.error);
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("syncAgentTools: unexpected error:", msg);
    return { version: null, synced: false, error: msg };
  }
}
