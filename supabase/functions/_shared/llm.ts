// _shared/llm.ts
// Contrato único para las llamadas directas a la Messages API (clasificador,
// graders, respuesta pública a comentarios, Dreams). Existe por Haiku 5.5:
//
//  - Adaptive thinking está ACTIVO por defecto: la respuesta puede empezar con
//    uno o más bloques `thinking` (vacíos con display "omitted"), así que NADIE
//    debe leer `content[0]` — se lee el bloque de texto (textOf).
//  - El thinking cuenta contra `max_tokens`: un tope dimensionado para el JSON
//    pelado se agota pensando y la respuesta llega con stop_reason "max_tokens"
//    y el JSON cortado. Cada ruta declara su perfil (effort + holgura).
//  - Los clasificadores de seguridad pueden declinar con HTTP 200 y
//    stop_reason "refusal" (sin fallback server-side en Haiku 5.5). Es una
//    falla explícita y tipada, no un texto vacío que se confunde con otra cosa.
//  - Haiku 5.5 rechaza (400) temperature/top_p/top_k distintos del default y
//    `thinking.budget_tokens`: no se envían. La profundidad de razonamiento se
//    controla SOLO con `output_config.effort`.
//
// Fuente (2026-10-13): guía "Migrating to Claude Haiku 5.5" de la documentación
// de Anthropic (skill claude-api) y platform.claude.com/docs/en/about-claude/pricing.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Estructural a propósito: acepta Anthropic.Message sin importar el SDK acá
// (este módulo es puro y testeable sin red).
export type MessageLike = {
  content: ReadonlyArray<{ type: string; text?: string }>;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: unknown;
};

export class LlmError extends Error {
  constructor(message: string, readonly label: string, readonly usage?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}
/** El modelo declinó por política de seguridad (stop_reason "refusal"). Determinístico: reintentar el mismo input no sirve. */
export class LlmRefusalError extends LlmError {
  constructor(label: string, readonly category: string | null, usage?: unknown) {
    super(`${label}: el modelo rechazó la solicitud (refusal${category ? `/${category}` : ""})`, label, usage);
  }
}
/** La salida se cortó en max_tokens (thinking + respuesta no entraron). Nunca se usa el texto parcial. */
export class LlmTruncatedError extends LlmError {
  constructor(label: string, usage?: unknown) {
    super(`${label}: respuesta truncada por max_tokens`, label, usage);
  }
}
/** La respuesta no trae texto utilizable (solo thinking, o texto vacío). */
export class LlmEmptyError extends LlmError {
  constructor(label: string, usage?: unknown) {
    super(`${label}: la respuesta no trae bloque de texto`, label, usage);
  }
}

/** Texto de la respuesta, o una falla tipada. `label` identifica el call site en logs. */
export function textOf(res: MessageLike, label: string): string {
  if (res.stop_reason === "refusal") {
    throw new LlmRefusalError(label, res.stop_details?.category ?? null, res.usage);
  }
  if (res.stop_reason === "max_tokens") throw new LlmTruncatedError(label, res.usage);
  const text = res.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  if (!text.trim()) throw new LlmEmptyError(label, res.usage);
  return text;
}

/** JSON de la respuesta (structured outputs). */
export function jsonOf<T>(res: MessageLike, label: string): T {
  const text = textOf(res, label);
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new LlmError(`${label}: JSON inválido (${e instanceof Error ? e.message : String(e)})`, label, res.usage);
  }
}

// Perfil por call site. maxTokens deja holgura para el thinking ADEMÁS de la
// salida (se factura solo lo que se usa; es un techo, no un gasto). Se usan así:
//   max_tokens: LLM_PROFILES.classify.maxTokens,
//   output_config: { effort: LLM_PROFILES.classify.effort, format: {...} },
export const LLM_PROFILES = {
  // Una vez por mensaje entrante: JSON chico. Razonamiento mínimo.
  classify: { effort: "low", maxTokens: 4096 },
  // Juzga calidad contra una rúbrica: algo más de razonamiento.
  grader: { effort: "medium", maxTokens: 4096 },
  // Texto <= 280 chars.
  commentReply: { effort: "low", maxTokens: 2048 },
  // Extracción de aprendizajes desde transcripts largos: JSON grande.
  dreamsLearnings: { effort: "medium", maxTokens: 16000 },
  // Consolidación del digest (tope duro de ~900 palabras después).
  dreamsDigest: { effort: "low", maxTokens: 8000 },
} as const satisfies Record<string, { effort: Effort; maxTokens: number }>;

export type LlmProfileName = keyof typeof LLM_PROFILES;
