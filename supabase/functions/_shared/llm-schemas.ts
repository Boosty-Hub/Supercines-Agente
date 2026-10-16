// _shared/llm-schemas.ts — TODOS los json_schema de structured output (output_config.format)
// de las Edge Functions viven acá, cerrados, y los cubre llm-schemas.test.ts.
//
// Por qué (bug real): la API exige `additionalProperties: false` en CADA objeto de un
// json_schema y, sin él, responde 400 («output_config.format.schema: For 'object' type,
// 'additionalProperties' must be explicitly set to false»). El schema del grader de
// evaluate-outcomes no lo tenía: LAM guardó 13.380 evaluaciones con score NULL entre el
// 25-jun y el 14-sep de 2026 (se arregló solo en su despliegue, no en git) y SuperCines
// volvió a quedar con el 100 % de los llm_judge en ERROR desde el 15-oct al pasar a Haiku 5.5.
// Un schema nuevo se declara acá (no inline en la llamada): la guardia de
// llm-schemas.test.ts falla con cualquier `type: "json_schema"` seguido de un literal.

/** Schema JSON mínimo que usamos (objetos, arrays, escalares, enums). */
export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly (string | number)[];
  [k: string]: unknown;
};

/** Rutas de los objetos del schema que NO declaran `additionalProperties: false`. */
export function openObjectPaths(schema: JsonSchema, path = "$"): string[] {
  const out: string[] = [];
  const isObject = schema.type === "object" || schema.properties !== undefined;
  if (isObject && schema.additionalProperties !== false) out.push(path);
  for (const [k, v] of Object.entries(schema.properties ?? {})) out.push(...openObjectPaths(v, `${path}.${k}`));
  if (schema.items) out.push(...openObjectPaths(schema.items, `${path}[]`));
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const list = schema[key];
    if (Array.isArray(list)) list.forEach((s, i) => out.push(...openObjectPaths(s as JsonSchema, `${path}.${key}[${i}]`)));
  }
  return out;
}

/** Grader LLM-judge con escala pass_fail. */
export const GRADER_PASS_FAIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    passed: { type: "boolean" },
    reasoning: { type: "string" },
  },
  required: ["passed", "reasoning"],
} as const satisfies JsonSchema;

/** Grader LLM-judge con escala numeric_0_1. */
export const GRADER_SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "number" },
    reasoning: { type: "string" },
  },
  required: ["score", "reasoning"],
} as const satisfies JsonSchema;

/** Learnings de Dreams (dreams-run). */
export const DREAMS_LEARNINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    learnings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          category: { type: "string" },
          severity: { type: "string", enum: ["sugerencia", "advertencia", "error"] },
          vertical: { type: "string" },
          content: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["title", "category", "severity", "vertical", "content", "evidence"],
      },
    },
  },
  required: ["learnings"],
} as const satisfies JsonSchema;

/** Clasificador de process-inbound (el enum de verticales depende de la base). */
export function classifySchema(verticalSlugs: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      vertical_slug: { type: "string", enum: verticalSlugs },
      intent: {
        type: "string",
        enum: ["info", "purchase", "support", "feedback", "spam", "other"],
      },
      urgency: { type: "integer" },
      toxicity: { type: "number" },
      requires_human_review: { type: "boolean" },
      confidence: { type: "number" },
      reasoning: { type: "string" },
      media_summary: { type: "string" },
    },
    required: [
      "vertical_slug",
      "intent",
      "urgency",
      "toxicity",
      "requires_human_review",
      "confidence",
      "reasoning",
      "media_summary",
    ],
  } satisfies JsonSchema;
}
