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
import { configValues, setConfigValues } from "@/lib/runtime-config";
import {
  scaffoldHash,
  buildAgentTools,
  composeSystem,
  filterToolRowsByGates,
  type AgentToolRow,
  type ToolGateFlags,
} from "@/lib/agent-prompt";
import { listMemories, retrieveAgent, updateAgent, type NamedResource } from "@/lib/anthropic-managed";
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
}

/** Cómo resolver un conflicto de prompt (decisión EXPLÍCITA del usuario). */
export type ConflictResolution = "overwrite" | "import_live";

class PromptConflictError extends Error {
  constructor(public conflict: PromptConflict) {
    super(`${conflictMessage(conflict)} No se sincronizó: resolvelo en la página Agente (importar el vivo o sobrescribir).`);
    this.name = "PromptConflictError";
  }
}

type Payload = {
  apiKey: string;
  agentId: string;
  system: string;
  tools: unknown[];
  syncedHash: string | undefined;
  registeredVersion: number | null;
};

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
    "AGENT_PROMPT_SYNCED_HASH",
    "ANTHROPIC_AGENT_VERSION",
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
  const system = composeSystem(
    cfg.SYSTEM_PROMPT ?? "",
    {
      operatorName: cfg.OPERATOR_NAME || "el operador",
      masterStoreName: cfg.MEMORY_STORE_MASTER_NAME || "master",
      leadsStoreName: cfg.MEMORY_STORE_LEADS_NAME || "leads",
    },
    httpRows,
    rows.map((r) => r.name),
    { hasVoice }
  );

  const reg = Number(cfg.ANTHROPIC_AGENT_VERSION);
  return {
    apiKey,
    agentId,
    system,
    tools,
    syncedHash: cfg.AGENT_PROMPT_SYNCED_HASH || undefined,
    registeredVersion: Number.isFinite(reg) && reg > 0 ? reg : null,
  };
}

const liveSystemOf = (agent: NamedResource): string | null => (typeof agent.system === "string" ? agent.system : null);

function conflictOf(p: Payload, live: NamedResource): PromptConflict | null {
  return detectPromptConflict({
    liveSystem: liveSystemOf(live),
    liveVersion: typeof live.version === "number" ? live.version : null,
    syncedHash: p.syncedHash,
    registeredVersion: p.registeredVersion,
    composedSystem: p.system,
  });
}

/**
 * ¿El prompt vivo fue modificado fuera del dashboard? Para los caminos que cambian el
 * agente SIN empujar el prompt (p. ej. cambiar el modelo en /consumo): suben la versión
 * del agente y, sin este chequeo, taparían la señal. null = sin conflicto (o agente
 * sin aprovisionar / Anthropic no responde: no se afirma lo que no se pudo comprobar).
 * `retrieve` es inyectable: una página que además necesita el agente vivo para otra cosa
 * pasa un retriever compartido (lib/once-retriever) y el agente se lee UNA vez por render.
 */
export async function checkAgentPromptConflict(
  retrieve: AgentRetriever = retrieveAgent
): Promise<PromptConflict | null> {
  try {
    const payload = await buildPayload();
    if (!payload || "error" in payload) return null;
    return conflictOf(payload, await retrieve(payload.apiKey, payload.agentId));
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
    const { apiKey, agentId, system, tools } = payload;

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
      await setConfigValues(
        {
          SYSTEM_PROMPT: operatorPrompt,
          AGENT_PROMPT_SYNCED_HASH: hashPrompt(liveSystem),
          ANTHROPIC_AGENT_VERSION: String(version),
        },
        actor
      );
      return { version, synced: true, imported: true };
    }

    // 4. Optimistic concurrency: read current version then PATCH.
    const doUpdate = async (): Promise<number> => {
      const current = await retrieveAgent(apiKey, agentId);
      if (opts.resolve !== "overwrite") {
        const conflict = conflictOf(payload, current);
        if (conflict) throw new PromptConflictError(conflict);
      }
      const updated = await updateAgent(apiKey, agentId, {
        version: current.version,
        system,
        tools,
      });
      return (updated.version as number) ?? 0;
    };

    let newVersion: number;
    try {
      newVersion = await doUpdate();
    } catch (err) {
      if (err instanceof PromptConflictError) return { version: null, synced: false, error: err.message, conflict: err.conflict };
      const msg = err instanceof Error ? err.message : String(err);
      // On version-mismatch re-read once and retry. Match the 409 status or an
      // explicit "conflict" — NOT the bare word "version" (that also appears in
      // unrelated errors like a bad anthropic-version header).
      if (/\b409\b|conflict/i.test(msg)) {
        try {
          newVersion = await doUpdate();
        } catch (retryErr) {
          if (retryErr instanceof PromptConflictError) {
            return { version: null, synced: false, error: retryErr.message, conflict: retryErr.conflict };
          }
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error("syncAgentTools: retry failed:", retryMsg);
          return { version: null, synced: false, error: retryMsg };
        }
      } else {
        console.error("syncAgentTools: updateAgent failed:", msg);
        return { version: null, synced: false, error: msg };
      }
    }

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
