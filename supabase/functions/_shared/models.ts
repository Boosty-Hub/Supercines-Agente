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

/** Modelo configurado para `key` (DB-first/env-fallback) o el default del pipeline. */
export function modelFor(cfg: { getOr(key: string, fallback: string): string }, key: ModelKey): string {
  return cfg.getOr(key, MODEL_DEFAULTS[key]);
}
