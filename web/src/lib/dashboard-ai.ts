// server-only: modelo y helpers de las rutas del dashboard que generan con IA
// (verticales, filtros, graders, plantillas de seguimiento, wizard de setup).
//
// TODAS usan Haiku 5.5 (DEFAULT_MODEL). Este módulo es el único lugar donde se
// elige el modelo y el esfuerzo de esas rutas.
//
// Por qué `fetch` envuelto (shapedFetch, lib/model-capabilities.ts): el Vercel AI
// SDK (ai@5 / @ai-sdk/anthropic@2) (a) no conoce `output_config.effort` — Haiku 5.5
// piensa por defecto con effort "medium" y estas tareas no necesitan ese
// razonamiento — y (b) manda `temperature` por DEFAULT, que Haiku 5.5 rechaza con
// 400. El wrapper normaliza el body según las capacidades del modelo (quita
// sampling, inyecta effort).
//
// maxOutputTokens SIEMPRE explícito (DASHBOARD_MAX_OUTPUT_TOKENS): @ai-sdk/anthropic@2
// no conoce claude-haiku-5-5 y, sin tope, manda max_tokens=128000 en generateObject
// — una request que Anthropic puede rechazar o cobrar de más. supabase/tests/
// dashboard-ai-body.test.ts captura el body real y falla si el tope no viaja.
//
// Notas de comportamiento con Haiku 5.5:
//  - generateObject usa tool_choice forzado: Haiku 5.5 lo acepta y, en ese caso,
//    la respuesta empieza directo por la tool (sin bloque `thinking`).
//  - streamText sí puede emitir `thinking` (el AI SDK lo separa del texto), y el
//    thinking cuenta contra maxTokens: dimensionar con holgura.
//  - Un stop_reason "refusal": el AI SDK v5 (provider v2) lo mapea a finishReason
//    "content-filter" (el v4 lo mapeaba a "unknown"); se cubren los dos.

import { createAnthropic } from "@ai-sdk/anthropic";
import { NoObjectGeneratedError } from "ai";
import { DEFAULT_MODEL } from "@/lib/model-config";
import { shapedFetch, type RequestEffort } from "@/lib/model-capabilities";

export const DASHBOARD_MODEL = DEFAULT_MODEL;

export type DashboardEffort = RequestEffort;

/** Tope de salida (thinking incluido) de las rutas de generación de objetos. */
export const DASHBOARD_MAX_OUTPUT_TOKENS = 8000;
/** Tope de salida de la generación de un system prompt completo (streamText). */
export const DASHBOARD_LONG_OUTPUT_TOKENS = 16000;

/** Modelo AI SDK para las rutas del dashboard, con esfuerzo explícito. */
export function dashboardModel(apiKey: string, effort: DashboardEffort) {
  return createAnthropic({ apiKey, fetch: shapedFetch(effort) })(DASHBOARD_MODEL);
}

/** Mensaje claro para el operador ante una generación fallida. */
export function aiErrorMessage(err: unknown): string {
  if (NoObjectGeneratedError.isInstance(err)) {
    if (err.finishReason === "length") {
      return "La respuesta de la IA se cortó por longitud antes de terminar. Probá con un pedido más acotado.";
    }
    // "content-filter" = refusal en provider v2; "unknown" = el mapeo del v4.
    if (err.finishReason === "content-filter" || err.finishReason === "unknown") {
      return "La IA no devolvió un resultado (puede haber declinado el pedido por sus políticas de seguridad). Reformulá el pedido.";
    }
  }
  return err instanceof Error ? err.message : String(err);
}
