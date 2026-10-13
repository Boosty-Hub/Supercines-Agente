// Valor del campo `model` del Managed Agent. ÚNICO punto que lo arma: lo usan
// el alta (/api/setup/agent) y el cambio de modelo (/api/usage/models), para que
// ambos envíen siempre el mismo esfuerzo explícito.
//
// Por qué un objeto y no el string del modelo: Haiku 5.5 piensa por defecto
// (adaptive thinking) y su `effort` por defecto es "medium". Dejarlo implícito
// ata el costo y la latencia de cada respuesta a un default que Anthropic puede
// mover. Con el objeto `{ id, effort }` el esfuerzo queda declarado y versionado
// con el agente. (Semántica de update: si el `id` no cambia y se omite `effort`
// se conserva el guardado; si el `id` cambia y se omite, vuelve al default del
// modelo nuevo — por eso siempre se envía explícito.)
//
// Haiku 4.5 no soporta `effort` (da error), así que para ese modelo (histórico,
// todavía asignable) se envía el string plano.

export type AgentEffort = "low" | "medium" | "high";

/** Esfuerzo del agente conversacional. Chat con tools y respuestas cortas:
 *  "medium" es el punto de partida recomendado; subirlo solo si una evaluación
 *  (outcomes) muestra ganancia que justifique el costo. */
export const AGENT_EFFORT: AgentEffort = "medium";

// Mantener en sync con supabase/functions/_shared/models.ts (MODELS_WITHOUT_EFFORT).
export const MODELS_WITHOUT_EFFORT: ReadonlySet<string> = new Set(["claude-haiku-4-5"]);

export type AgentModelParam = string | { id: string; effort: AgentEffort };

export function agentModelParam(modelId: string): AgentModelParam {
  return MODELS_WITHOUT_EFFORT.has(modelId) ? modelId : { id: modelId, effort: AGENT_EFFORT };
}

/**
 * ¿El `model` que Anthropic tiene guardado en el agente ya es el deseado?
 * La API devuelve el modelo en forma de objeto y el effort como string o como
 * `{ type }`; se normaliza antes de comparar. La fuente de verdad es el AGENTE
 * VIVO, no runtime_config: comparar contra la config deja el agente en el modelo
 * viejo cuando la key de config no coincide con lo que realmente corre.
 */
export function agentModelMatches(live: unknown, desired: AgentModelParam): boolean {
  const norm = (m: unknown): { id: string; effort: string | null } | null => {
    if (typeof m === "string") return { id: m, effort: null };
    if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
      const e = (m as { effort?: unknown }).effort;
      const effort =
        typeof e === "string" ? e
        : e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string" ? (e as { type: string }).type
        : null;
      return { id: (m as { id: string }).id, effort };
    }
    return null;
  };
  const a = norm(live);
  const b = norm(desired);
  if (!a || !b) return false;
  // Sin effort deseado (Haiku 4.5) solo importa el id.
  return a.id === b.id && (b.effort === null || a.effort === b.effort);
}
