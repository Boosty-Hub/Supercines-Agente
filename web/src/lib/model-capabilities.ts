// Capacidades de request por modelo + la normalización del body que de ahí sale.
// SIN imports a propósito: es puro, lo usa el front (rutas del dashboard) y lo
// ejercita supabase/tests con el AI SDK real.
// Mantener en sync con supabase/functions/_shared/models.ts (MODEL_CAPS):
// web-parity.test.ts verifica que sean idénticas.
//
// Qué rechaza cada modelo con 400 (guías de migración de Anthropic, 2026-10-13):
//  - effort:   Haiku 4.5 no tiene `output_config.effort`.
//  - sampling: Haiku 5.5 solo acepta temperature=1 / top_p=0.99 (los defaults);
//              Opus 4.8 los eliminó. Cualquier otro valor, o top_k, da 400.
// Un modelo DESCONOCIDO no recibe effort y se le quita el sampling: omitir ambos
// es siempre válido.

export type ModelCaps = { effort: boolean; sampling: boolean };

export const MODEL_CAPS: Record<string, ModelCaps> = {
  "claude-haiku-5-5": { effort: true, sampling: false },
  "claude-haiku-4-5": { effort: false, sampling: true },
  "claude-sonnet-4-6": { effort: true, sampling: true },
  "claude-opus-4-8": { effort: true, sampling: false },
};

const UNKNOWN: ModelCaps = { effort: false, sampling: false };

export function capsFor(model: string): ModelCaps {
  return MODEL_CAPS[model] ?? UNKNOWN;
}

export type RequestEffort = "low" | "medium" | "high";

/**
 * Ajusta el body JSON de /v1/messages al modelo del propio body: quita
 * temperature/top_p/top_k si no los acepta e inyecta output_config.effort si lo
 * soporta. El AI SDK v4 manda `temperature: 0` por DEFAULT (ai/dist: "TODO v5
 * remove default 0 for temperature") y @ai-sdk/anthropic solo lo descarta con
 * thinking habilitado: sin esto, Haiku 5.5 devolvería 400 en cada generación.
 */
export function shapeAnthropicBody(
  body: Record<string, unknown>,
  effort: RequestEffort,
): Record<string, unknown> {
  const caps = capsFor(typeof body.model === "string" ? body.model : "");
  const out: Record<string, unknown> = { ...body };
  if (!caps.sampling) {
    delete out.temperature;
    delete out.top_p;
    delete out.top_k;
  }
  if (caps.effort) {
    const prev = (out.output_config && typeof out.output_config === "object" ? out.output_config : {}) as Record<string, unknown>;
    out.output_config = { ...prev, effort };
  }
  return out;
}

/** fetch que normaliza el body de las requests a la Messages API (ver shapeAnthropicBody). */
export function shapedFetch(effort: RequestEffort, baseFetch: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        return baseFetch(input, { ...init, body: JSON.stringify(shapeAnthropicBody(body, effort)) });
      } catch {
        // body no-JSON: se envía tal cual.
      }
    }
    return baseFetch(input, init);
  };
}

/** Modelo REAL de una sesión CMA (copia de _shared/usage.ts; paridad testeada). */
export function sessionModelId(session: unknown): string | null {
  const agent = (session as { agent?: unknown } | null)?.agent;
  const m = (agent as { model?: unknown } | null)?.model;
  if (typeof m === "string" && m) return m;
  const id = (m as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? id : null;
}

// ───────────────────────── Managed Agent ─────────────────────────
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


export type AgentModelParam = string | { id: string; effort: AgentEffort };

export function agentModelParam(modelId: string): AgentModelParam {
  return capsFor(modelId).effort ? { id: modelId, effort: AGENT_EFFORT } : modelId;
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
