// _shared/models.ts
// Modelo por defecto de cada componente del pipeline (fallback cuando
// runtime_config.<KEY> está vacío). ÚNICA fuente en Edge; web/src/lib/
// model-config.ts (MODEL_KEYS) debe coincidir — models.test.ts lo verifica.
export const DEFAULT_MODEL = "claude-haiku-5-5";

export const MODEL_DEFAULTS = {
  AGENT_MODEL: DEFAULT_MODEL,
  CLASSIFY_MODEL: DEFAULT_MODEL,
  COMMENT_REPLY_MODEL: DEFAULT_MODEL,
  GRADER_MODEL: DEFAULT_MODEL,
  DREAMS_MODEL: DEFAULT_MODEL,
} as const;

export type ModelKey = keyof typeof MODEL_DEFAULTS;

/** Modelos que rechazan `output_config.effort` con 400 (Haiku 4.5, histórico pero todavía asignable). */
export const MODELS_WITHOUT_EFFORT: ReadonlySet<string> = new Set(["claude-haiku-4-5"]);

/**
 * Fragmento de `output_config` con el effort, o {} si el modelo no lo soporta.
 * TODA llamada directa a la Messages API pasa por acá: `output_config: { ...effortFor(model, e), format }`.
 * Mantener en sync con web/src/lib/agent-model.ts (web-parity.test.ts lo verifica).
 */
export function effortFor(model: string, effort: "low" | "medium" | "high"): { effort?: "low" | "medium" | "high" } {
  return MODELS_WITHOUT_EFFORT.has(model) ? {} : { effort };
}

/** Modelo configurado para `key` (DB-first/env-fallback) o el default del pipeline. */
export function modelFor(cfg: { getOr(key: string, fallback: string): string }, key: ModelKey): string {
  return cfg.getOr(key, MODEL_DEFAULTS[key]);
}
