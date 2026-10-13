// server-only: modelo y helpers de las rutas del dashboard que generan con IA
// (verticales, filtros, graders, plantillas de seguimiento, wizard de setup).
//
// TODAS usan Haiku 5.5 (DEFAULT_MODEL). Este módulo es el único lugar donde se
// elige el modelo, el esfuerzo y el tope de salida de esas rutas.
//
// Cómo se configura (AI SDK v5, sin tocar el body a mano):
//  - effort: `providerOptions.anthropic.effort` nativo (@ai-sdk/anthropic lo manda
//    como `output_config.effort`). Haiku 5.5 piensa por defecto con effort "medium"
//    y estas tareas no necesitan ese razonamiento. Solo se envía si el modelo lo
//    soporta (capsFor): Haiku 4.5 lo rechaza con 400.
//  - maxOutputTokens: @ai-sdk/anthropic@2.0.106 no conoce `claude-haiku-5-5` y, sin
//    tope explícito, manda max_tokens=128000. Cada tarea declara el suyo en
//    DASHBOARD_TASKS; `defaultSettingsMiddleware` lo aplica a toda llamada del modelo.
//  - sampling: ninguna ruta envía temperature/top_p/top_k (ai@5 ya no manda
//    `temperature: 0` por default), que Haiku 5.5 rechazaría con 400.
//
// Notas de comportamiento con Haiku 5.5:
//  - generateObject usa tool_choice forzado: Haiku 5.5 lo acepta y, en ese caso,
//    la respuesta empieza directo por la tool (sin bloque `thinking`).
//  - streamText sí puede emitir `thinking` (el AI SDK lo separa del texto), y el
//    thinking cuenta contra maxOutputTokens: dimensionar con holgura.
//  - Un stop_reason "refusal" el provider v2 lo mapea a finishReason "content-filter"
//    ("unknown" queda cubierto por si el provider no reconoce otro stop_reason).

import { createAnthropic } from "@ai-sdk/anthropic";
import { defaultSettingsMiddleware, NoObjectGeneratedError, wrapLanguageModel } from "ai";
import { DEFAULT_MODEL } from "./model-config.ts";
import { capsFor, type RequestEffort } from "./model-capabilities.ts";

export const DASHBOARD_MODEL = DEFAULT_MODEL;

export type DashboardEffort = RequestEffort;

export type DashboardTask = { effort: DashboardEffort; maxOutputTokens: number };

/**
 * Esfuerzo y tope de salida por ruta. Los topes dan holgura sobre la salida
 * esperada (el schema de cada ruta) sin quedar en el default de 128K del provider.
 */
export const DASHBOARD_TASKS = {
  /** /api/setup/suggest-identity: dos strings cortos. */
  suggestIdentity: { effort: "low", maxOutputTokens: 1024 },
  /** /api/filters/generate: reglas de texto/canales, objeto chico. */
  filters: { effort: "low", maxOutputTokens: 2048 },
  /** /api/follow-up/templates/generate: una plantilla de WhatsApp. */
  followUpTemplate: { effort: "low", maxOutputTokens: 2048 },
  /** /api/verticales/generate: una vertical con su system_prompt. */
  vertical: { effort: "low", maxOutputTokens: 4096 },
  /** /api/graders/generate: un grader con su prompt de evaluación. */
  grader: { effort: "medium", maxOutputTokens: 4096 },
  /** /api/setup/plan-edit: una sección completa del prompt, reescrita. */
  planEdit: { effort: "low", maxOutputTokens: 8192 },
  /** /api/setup/suggest-verticals: hasta 5 verticales con su system_prompt. */
  suggestVerticals: { effort: "low", maxOutputTokens: 16000 },
  /** /api/setup/generate-agent (streamText): el prompt base completo (~4K tokens)
   *  más el thinking, que cuenta contra el tope. */
  generateAgent: { effort: "medium", maxOutputTokens: 16000 },
} as const satisfies Record<string, DashboardTask>;

type DashboardModelOptions = {
  /** Modelo a usar (default DASHBOARD_MODEL). */
  model?: string;
  /** fetch inyectable (tests). */
  fetch?: typeof fetch;
};

/** Modelo AI SDK para las rutas del dashboard, con esfuerzo y tope de salida explícitos. */
export function dashboardModel(apiKey: string, task: DashboardTask, opts: DashboardModelOptions = {}) {
  const modelId = opts.model ?? DASHBOARD_MODEL;
  const model = createAnthropic({ apiKey, fetch: opts.fetch })(modelId);
  return wrapLanguageModel({
    model,
    middleware: defaultSettingsMiddleware({
      settings: {
        maxOutputTokens: task.maxOutputTokens,
        providerOptions: capsFor(modelId).effort ? { anthropic: { effort: task.effort } } : undefined,
      },
    }),
  });
}

/** Mensaje claro para el operador ante una generación fallida. */
export function aiErrorMessage(err: unknown): string {
  if (NoObjectGeneratedError.isInstance(err)) {
    if (err.finishReason === "length") {
      return "La respuesta de la IA se cortó por longitud antes de terminar. Probá con un pedido más acotado.";
    }
    if (err.finishReason === "content-filter" || err.finishReason === "unknown") {
      return "La IA no devolvió un resultado (puede haber declinado el pedido por sus políticas de seguridad). Reformulá el pedido.";
    }
  }
  return err instanceof Error ? err.message : String(err);
}
