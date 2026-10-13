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

// Capacidades de request por modelo. COPIA de web/src/lib/model-capabilities.ts
// (web-parity.test.ts verifica que sean idénticas). Ver ahí qué rechaza cada
// modelo con 400. Las llamadas Edge no mandan sampling (temperature/top_p/top_k);
// `sampling` queda en la tabla para mantener una sola definición de la capacidad.
export type ModelCaps = { effort: boolean; sampling: boolean };
export const MODEL_CAPS: Record<string, ModelCaps> = {
  "claude-haiku-5-5": { effort: true, sampling: false },
  "claude-haiku-4-5": { effort: false, sampling: true },
  "claude-sonnet-4-6": { effort: true, sampling: true },
  "claude-opus-4-8": { effort: true, sampling: false },
};

/**
 * Fragmento de `output_config` con el effort, o {} si el modelo no lo soporta.
 * TODA llamada directa a la Messages API pasa por acá: `output_config: { ...effortFor(model, e), format }`.
 * Un modelo desconocido no recibe effort (omitirlo siempre es válido).
 */
export function effortFor(model: string, effort: "low" | "medium" | "high"): { effort?: "low" | "medium" | "high" } {
  return MODEL_CAPS[model]?.effort ? { effort } : {};
}

/** Modelo configurado para `key` (DB-first/env-fallback) o el default del pipeline. */
export function modelFor(cfg: { getOr(key: string, fallback: string): string }, key: ModelKey): string {
  return cfg.getOr(key, MODEL_DEFAULTS[key]);
}
