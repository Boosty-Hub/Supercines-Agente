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
import {
  scaffoldHash,
  buildAgentTools,
  composeSystem,
  type PlaceholderValues,
  filterToolRowsByGates,
  type AgentToolRow,
  type ToolGateFlags,
} from "@/lib/agent-prompt";
import { listMemories, renameAgentResource, retrieveAgent, updateAgent, type NamedResource } from "@/lib/anthropic-managed";
import { versionToRecordAfterRename } from "@/lib/agent-rename";
import { guardedPush } from "@/lib/guarded-push";
import { placeholderize, type PlaceholderizeResult } from "@/lib/prompt-placeholders";
import type { AgentRetriever } from "@/lib/once-retriever";
import {
  conflictMessage,
  detectPromptConflict,
  extractOperatorPrompt,
  hashPrompt,
  type PromptConflict,
} from "@/lib/agent-prompt-sync";

/**
 * Detecta si el master Memory Store tiene archivos de voz (/voice/). Con la
 * carpeta vacía, el paso de voz del scaffold era un turno muerto en CADA
 * sesión del agente. Fail-open: ante cualquier error devuelve true (mantener
 * el paso = comportamiento previo, nunca se pierde una voz real).
 */
export async function detectVoiceFiles(
  apiKey: string,
  masterStoreId: string | undefined
): Promise<boolean> {
  if (!masterStoreId) return true;
  try {
    const items = await listMemories(apiKey, masterStoreId, "/voice/");
    return items.length > 0;
  } catch {
    return true;
  }
}

export interface SyncResult {
  version: number | null;
  synced: boolean;
  error?: string;
  /**
   * El prompt vivo en Anthropic fue modificado fuera del dashboard (o no hay
   * sincronización previa registrada y difiere): NO se sincronizó. El llamador debe
   * ofrecer «importar el vivo» o «sobrescribir con el de la DB» (ver agent-prompt-sync.ts).
   */
  conflict?: PromptConflict;
  /** Se importó el prompt vivo a la DB (resolve = import_live); no se empujó nada. */
  imported?: boolean;
  /** Con import_live: qué placeholders se restituyeron y cuáles valores quedaron ambiguos (sin tocar). */
  placeholders?: PlaceholderizeResult;
}

/** Cómo resolver un conflicto de prompt (decisión EXPLÍCITA del usuario). */
export type ConflictResolution = "overwrite" | "import_live";

const conflictError = (c: PromptConflict) =>
  `${conflictMessage(c)} No se sincronizó: resolvelo en la página Agente (importar el vivo o sobrescribir).`;

type Payload = {
  apiKey: string;
  agentId: string;
  system: string;
  tools: unknown[];
  /** Línea base de la sincronización segura (releída de la DB, no memoizada). */
  baseline: Baseline;
  values: PlaceholderValues;
};

/** Hash del último system enviado y versión registrada: contra lo que se detecta una edición externa. */
type Baseline = { syncedHash: string | undefined; registeredVersion: number | null };

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
export async function renameAgent(apiKey: string, agentId: string, name: string, actor: string): Promise<void> {
  const result = await renameAgentResource(apiKey, agentId, name);
  const { registeredVersion } = await readBaseline();
  const record = versionToRecordAfterRename({ registered: registeredVersion, result });
  if (record !== null) await setConfigValues({ ANTHROPIC_AGENT_VERSION: String(record) }, actor);
}

/**
 * Arma lo que se empujaría al agente (system compuesto + tools) desde la DB.
 * Devuelve `null` si el agente no está aprovisionado (no hay nada que sincronizar) o
 * `{ error }` ante un fallo de lectura (se aborta en vez de empujar una superficie
 * degradada).
 */
async function buildPayload(): Promise<Payload | null | { error: string }> {
  // 1. Resolve required config keys.
  const cfg = await configValues([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AGENT_ID",
    "ANTHROPIC_MEMORY_MASTER_ID",
    "OPERATOR_NAME",
    "MEMORY_STORE_MASTER_NAME",
    "MEMORY_STORE_LEADS_NAME",
    "SYSTEM_PROMPT",
  ]);

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

  const rows = filterToolRowsByGates(
    (data ?? []) as AgentToolRow[],
    (gateRow ?? null) as ToolGateFlags | null
  );

  // 3. Build tools array and substitute system-prompt placeholders.
  const tools = buildAgentTools(rows);
  const httpRows = rows.filter((r) => r.tool_type === "http");

  // Paso de voz condicional: si /voice/ está vacío en el master store, el
  // scaffold omite ese paso (era un turno muerto por sesión).
  const hasVoice = await detectVoiceFiles(apiKey, cfg.ANTHROPIC_MEMORY_MASTER_ID);

  // composeSystem prepends the operator's editable prompt and appends the
  // fixed CORE_SCAFFOLD (machinery + security), then substitutes placeholders.
  // The declared tool names drive the scaffold's CRM actions block so the
  // prompt only mentions tools the agent can actually call.
  const values: PlaceholderValues = {
    operatorName: cfg.OPERATOR_NAME || "el operador",
    masterStoreName: cfg.MEMORY_STORE_MASTER_NAME || "master",
    leadsStoreName: cfg.MEMORY_STORE_LEADS_NAME || "leads",
  };
  const system = composeSystem(
    cfg.SYSTEM_PROMPT ?? "",
    values,
    httpRows,
    rows.map((r) => r.name),
    { hasVoice }
  );

  return { apiKey, agentId, system, tools, baseline: await readBaseline(), values };
}

const liveSystemOf = (agent: NamedResource): string | null => (typeof agent.system === "string" ? agent.system : null);

function conflictOf(p: Payload, live: NamedResource, baseline: Baseline = p.baseline): PromptConflict | null {
  return detectPromptConflict({
    liveSystem: liveSystemOf(live),
    liveVersion: typeof live.version === "number" ? live.version : null,
    syncedHash: baseline.syncedHash,
    registeredVersion: baseline.registeredVersion,
    composedSystem: p.system,
    placeholderValues: p.values,
  });
}

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
 * @param actor  Email or identifier of the user triggering the sync (for
 *               audit trail in runtime_config.updated_by).
 */
export async function syncAgentTools(
  actor: string,
  opts: { resolve?: ConflictResolution } = {}
): Promise<SyncResult> {
  try {
    const payload = await buildPayload();
    if (!payload) return { version: null, synced: false };
    if ("error" in payload) return { version: null, synced: false, error: payload.error };
    const { apiKey, agentId, system, tools, values } = payload;

    // Importar lo vivo a la DB: no se empuja nada.
    if (opts.resolve === "import_live") {
      const live = await retrieveAgent(apiKey, agentId);
      const liveSystem = liveSystemOf(live);
      const operatorPrompt = liveSystem ? extractOperatorPrompt(liveSystem) : null;
      if (!liveSystem || operatorPrompt === null) {
        return {
          version: null,
          synced: false,
          error:
            "No se pudo separar el prompt del operador del agente vivo (el bloque del sistema fue modificado). Sobrescribí con el de la DB o editalo a mano.",
        };
      }
      const version = typeof live.version === "number" ? live.version : 0;
      // El vivo trae los placeholders YA sustituidos: se restituyen los valores conocidos
      // (inversa de substitutePlaceholders) para que renombrar el operador o un store siga
      // propagándose. Los valores ambiguos (cortos / palabras comunes) NO se tocan y se informan.
      const placeholders = placeholderize(operatorPrompt, values);
      await setConfigValues(
        {
          SYSTEM_PROMPT: placeholders.text,
          AGENT_PROMPT_SYNCED_HASH: hashPrompt(liveSystem),
          ANTHROPIC_AGENT_VERSION: String(version),
        },
        actor
      );
      return { version, synced: true, imported: true, placeholders };
    }

    // 4. Concurrencia optimista + sincronización segura (lib/guarded-push): ante un 409 se
    //    reintenta una vez RELEYENDO la línea base registrada.
    const pushed = await guardedPush(
      {
        readBaseline,
        retrieve: () => retrieveAgent(apiKey, agentId),
        detect: (live, baseline) => conflictOf(payload, live, baseline),
        push: async (version) => {
          const updated = await updateAgent(apiKey, agentId, { version, system, tools });
          return (updated.version as number) ?? 0;
        },
        // El 409 de versión, o un «conflict» explícito — NO la palabra «version» suelta (aparece
        // también en errores ajenos, p. ej. un header anthropic-version inválido).
        isVersionConflict: (err) => /\b409\b|conflict/i.test(err instanceof Error ? err.message : String(err)),
      },
      { overwrite: opts.resolve === "overwrite", initialBaseline: payload.baseline }
    );
    if (!pushed.ok) {
      if ("conflict" in pushed) {
        return { version: null, synced: false, error: conflictError(pushed.conflict), conflict: pushed.conflict };
      }
      console.error("syncAgentTools: updateAgent failed:", pushed.error);
      return { version: null, synced: false, error: pushed.error };
    }
    const newVersion = pushed.version;

    // 5. Persist the bumped version so the editor page can show it, y el hash del
    //    system EXACTO que se envió: es la referencia contra la que la próxima
    //    sincronización detecta una edición externa.
    await setConfigValues(
      {
        ANTHROPIC_AGENT_VERSION: String(newVersion),
        AGENT_SCAFFOLD_HASH: scaffoldHash(),
        AGENT_PROMPT_SYNCED_HASH: hashPrompt(system),
      },
      actor
    );

    return { version: newVersion, synced: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("syncAgentTools: unexpected error:", msg);
    return { version: null, synced: false, error: msg };
  }
}
