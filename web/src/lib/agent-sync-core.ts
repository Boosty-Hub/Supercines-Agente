// Núcleo PURO de la sincronización del agente (sin I/O, sin `@/`, sin server-only).
//
// Lo comparten DOS consumidores que tienen que dar las mismas garantías:
//   - lib/sync-agent-tools.ts (rutas de la web: «Sincronizar», guardar /agent, toggles);
//   - scripts/sync-agent.mjs (CLI para mantenimiento de flota, importa este archivo con el
//     type-stripping nativo de Node >= 22.18).
// Por eso los imports son relativos con extensión `.ts` y todo el I/O (leer el agente vivo,
// empujar, leer/escribir runtime_config) entra por `SyncIO`. Si cada consumidor decidiera por
// su cuenta, la CLI podría pisar un prompt editado por fuera o registrar una huella distinta.
import {
  buildAgentTools,
  composeSystem,
  filterToolRowsByGates,
  renderToolsList,
  scaffoldHash,
  type AgentToolRow,
  type PlaceholderValues,
  type ToolGateFlags,
} from "./agent-prompt.ts";
import {
  checkResolveHash,
  conflictMessage,
  detectPromptConflict,
  extractOperatorPrompt,
  hashPrompt,
  type PromptConflict,
} from "./agent-prompt-sync.ts";
import { guardedPush, type PushBaseline } from "./guarded-push.ts";
import { placeholderize, type PlaceholderizeResult } from "./prompt-placeholders.ts";

/** Claves de runtime_config que componen el system y las tools. */
export const PAYLOAD_CONFIG_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AGENT_ID",
  "ANTHROPIC_MEMORY_MASTER_ID",
  "OPERATOR_NAME",
  "MEMORY_STORE_MASTER_NAME",
  "MEMORY_STORE_LEADS_NAME",
  "SYSTEM_PROMPT",
] as const;
export type PayloadConfig = Partial<Record<(typeof PAYLOAD_CONFIG_KEYS)[number], string | undefined>>;

export type Baseline = PushBaseline;

export type SyncPayload = {
  system: string;
  tools: unknown[];
  /** Línea base de la sincronización segura (releída de la DB, no memoizada). */
  baseline: Baseline;
  values: PlaceholderValues;
  /** Texto con que se sustituyó {{TOOLS_LIST}} (para restituirlo al importar el vivo). */
  toolsList: string;
};

/**
 * Compone lo que se empujaría al agente desde la DB: el prompt del operador + CORE_SCAFFOLD
 * (composeSystem) y las tools filtradas por las compuertas. NUNCA toca SYSTEM_PROMPT.
 */
export function composeSyncPayload(input: {
  cfg: PayloadConfig;
  /** Filas enabled de agent_tools en el orden en que se renderizan. */
  toolRows: AgentToolRow[];
  /** kommo_publish_config activo (compuertas de acciones) o null. */
  gateRow: ToolGateFlags | null;
  hasVoice: boolean;
  baseline: Baseline;
}): SyncPayload {
  const { cfg, toolRows, gateRow, hasVoice, baseline } = input;
  const rows = filterToolRowsByGates(toolRows, gateRow);
  const tools = buildAgentTools(rows);
  const httpRows = rows.filter((r) => r.tool_type === "http");
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
  return { system, tools, baseline, values, toolsList: renderToolsList(httpRows) };
}

export type LiveAgent = { version?: unknown; system?: unknown; model?: unknown };

export const liveSystemOf = (agent: LiveAgent): string | null => (typeof agent.system === "string" ? agent.system : null);

export function conflictFor(payload: SyncPayload, live: LiveAgent, baseline: Baseline = payload.baseline): PromptConflict | null {
  return detectPromptConflict({
    liveSystem: liveSystemOf(live),
    liveVersion: typeof live.version === "number" ? live.version : null,
    syncedHash: baseline.syncedHash,
    registeredVersion: baseline.registeredVersion,
    composedSystem: payload.system,
    placeholderValues: payload.values,
    toolsList: payload.toolsList,
  });
}

export interface SyncResult {
  version: number | null;
  synced: boolean;
  error?: string;
  /** El prompt vivo fue modificado fuera del dashboard (o primera vez y difiere): NO se sincronizó. */
  conflict?: PromptConflict;
  /** La resolución se abortó porque el vivo cambió desde que se le mostró al operador. */
  stale?: boolean;
  /** Se importó el prompt vivo a la DB (resolve = import_live); no se empujó nada. */
  imported?: boolean;
  placeholders?: PlaceholderizeResult;
}

/** Cómo resolver un conflicto de prompt (decisión EXPLÍCITA del usuario). */
export type ConflictResolution = "overwrite" | "import_live";

export const STALE_ERROR =
  "El prompt del agente en Anthropic cambió mientras lo revisabas. No se hizo nada: revisá el diff actualizado y elegí de nuevo.";

export const conflictError = (c: PromptConflict) =>
  `${conflictMessage(c)} No se sincronizó: resolvelo en la página Agente (importar el vivo o sobrescribir).`;

export type SyncIO = {
  /** Línea base registrada, leída en el momento (no memoizada). */
  readBaseline: () => Promise<Baseline>;
  retrieve: () => Promise<LiveAgent>;
  /** Empuja con la versión leída (`extra` = campos adicionales, p. ej. model); devuelve la versión nueva. */
  update: (version: unknown, body: { system: string; tools: unknown[] } & Record<string, unknown>) => Promise<number>;
  /** Escribe runtime_config (el llamador decide quién firma). */
  writeConfig: (values: Record<string, string>) => Promise<void>;
};

/** El 409 de versión, o un «conflict» explícito — NO la palabra «version» suelta (aparece en errores ajenos). */
export const isVersionConflict = (err: unknown): boolean => /\b409\b|conflict/i.test(err instanceof Error ? err.message : String(err));

/**
 * Decisión + escritura de la sincronización. ÚNICO camino que decide:
 *  · import_live: trae el prompt vivo del operador a SYSTEM_PROMPT (nada se empuja);
 *  · el resto: guardedPush (conflicto → aborta; overwrite → pisa) y registra
 *    ANTHROPIC_AGENT_VERSION / AGENT_SCAFFOLD_HASH / AGENT_PROMPT_SYNCED_HASH.
 * `resolve` exige `expectedLiveHash` (anti-TOCTOU).
 */
export async function runAgentSync(
  io: SyncIO,
  payload: SyncPayload,
  opts: {
    resolve?: ConflictResolution;
    expectedLiveHash?: string;
    /** Campos extra a enviar en el mismo update (p. ej. `{ model }`). */
    extraBody?: Record<string, unknown>;
  } = {}
): Promise<SyncResult> {
  const { system, tools, values, toolsList } = payload;
  if (opts.resolve && !opts.expectedLiveHash) {
    return { version: null, synced: false, error: "Falta el hash del prompt vivo que se revisó (expectedLiveHash): recargá la página y volvé a elegir." };
  }

  if (opts.resolve === "import_live") {
    const live = await io.retrieve();
    const liveSystem = liveSystemOf(live);
    if (!checkResolveHash(opts.expectedLiveHash, liveSystem).ok) {
      return { version: null, synced: false, stale: true, conflict: conflictFor(payload, live) ?? undefined, error: STALE_ERROR };
    }
    const operatorPrompt = liveSystem ? extractOperatorPrompt(liveSystem) : null;
    if (!liveSystem || operatorPrompt === null) {
      return {
        version: null,
        synced: false,
        error: "No se pudo separar el prompt del operador del agente vivo (el bloque del sistema fue modificado). Sobrescribí con el de la DB o editalo a mano.",
      };
    }
    const version = typeof live.version === "number" ? live.version : 0;
    const placeholders = placeholderize(operatorPrompt, values, { toolsList });
    await io.writeConfig({
      SYSTEM_PROMPT: placeholders.text,
      AGENT_PROMPT_SYNCED_HASH: hashPrompt(liveSystem),
      ANTHROPIC_AGENT_VERSION: String(version),
    });
    return { version, synced: true, imported: true, placeholders };
  }

  const pushed = await guardedPush(
    {
      readBaseline: io.readBaseline,
      retrieve: io.retrieve,
      detect: (live, baseline) => conflictFor(payload, live, baseline),
      push: (version) => io.update(version, { ...(opts.extraBody ?? {}), system, tools }),
      isVersionConflict,
      liveHash: (live) => hashPrompt(liveSystemOf(live) ?? ""),
    },
    {
      overwrite: opts.resolve === "overwrite",
      initialBaseline: payload.baseline,
      expectedLiveHash: opts.resolve ? opts.expectedLiveHash : undefined,
    }
  );
  if (!pushed.ok) {
    if ("stale" in pushed) return { version: null, synced: false, stale: true, conflict: pushed.freshConflict ?? undefined, error: STALE_ERROR };
    if ("conflict" in pushed) return { version: null, synced: false, error: conflictError(pushed.conflict), conflict: pushed.conflict };
    return { version: null, synced: false, error: pushed.error };
  }
  await io.writeConfig({
    ANTHROPIC_AGENT_VERSION: String(pushed.version),
    AGENT_SCAFFOLD_HASH: scaffoldHash(),
    AGENT_PROMPT_SYNCED_HASH: hashPrompt(system),
  });
  return { version: pushed.version, synced: true };
}

/** Resumen de un diff por líneas para el dry-run: cuántas líneas se agregan/quitan. */
export function diffCounts(diff: { type: "same" | "add" | "del" }[] | null | undefined): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const d of diff ?? []) {
    if (d.type === "add") add++;
    else if (d.type === "del") del++;
  }
  return { add, del };
}
