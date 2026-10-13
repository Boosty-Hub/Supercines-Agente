// server-only: modelo y helpers de las rutas del dashboard que generan con IA
// (verticales, filtros, graders, plantillas de seguimiento, wizard de setup).
//
// TODAS usan Haiku 5.5 (DEFAULT_MODEL). Este módulo es el único lugar donde se
// elige el modelo y el esfuerzo de esas rutas.
//
// Por qué `fetch` envuelto: el Vercel AI SDK instalado (ai@4 / @ai-sdk/anthropic@1)
// no conoce `output_config.effort`. Haiku 5.5 piensa por defecto (adaptive
// thinking) con effort "medium"; sin declararlo, cada generación paga un
// razonamiento que estas tareas no necesitan. El wrapper inyecta
// `output_config.effort` en el body de /v1/messages y no toca nada más. Se
// retira el día que el proyecto migre al AI SDK v5, que lo expone como opción.
//
// Notas de comportamiento con Haiku 5.5:
//  - generateObject usa tool_choice forzado: Haiku 5.5 lo acepta y, en ese caso,
//    la respuesta empieza directo por la tool (sin bloque `thinking`).
//  - streamText sí puede emitir `thinking` (el AI SDK lo separa del texto), y el
//    thinking cuenta contra maxTokens: dimensionar con holgura.
//  - Un stop_reason "refusal" el AI SDK v4 lo mapea a finishReason "unknown".

import { createAnthropic } from "@ai-sdk/anthropic";
import { NoObjectGeneratedError } from "ai";
import { DEFAULT_MODEL } from "@/lib/model-config";

export const DASHBOARD_MODEL = DEFAULT_MODEL;

export type DashboardEffort = "low" | "medium" | "high";

function withEffort(effort: DashboardEffort): typeof fetch {
  return (input, init) => {
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as { output_config?: Record<string, unknown> };
        body.output_config = { ...(body.output_config ?? {}), effort };
        return fetch(input, { ...init, body: JSON.stringify(body) });
      } catch {
        // body no-JSON: se envía tal cual (el effort por defecto del modelo aplica).
      }
    }
    return fetch(input, init);
  };
}

/** Modelo AI SDK para las rutas del dashboard, con esfuerzo explícito. */
export function dashboardModel(apiKey: string, effort: DashboardEffort) {
  return createAnthropic({ apiKey, fetch: withEffort(effort) })(DASHBOARD_MODEL);
}

/** Mensaje claro para el operador ante una generación fallida. */
export function aiErrorMessage(err: unknown): string {
  if (NoObjectGeneratedError.isInstance(err)) {
    if (err.finishReason === "length") {
      return "La respuesta de la IA se cortó por longitud antes de terminar. Probá con un pedido más acotado.";
    }
    if (err.finishReason === "unknown") {
      return "La IA no devolvió un resultado (puede haber declinado el pedido por sus políticas de seguridad). Reformulá el pedido.";
    }
  }
  return err instanceof Error ? err.message : String(err);
}
