// _shared/halt.ts
//
// Kill switch TOTAL: kommo_publish_config.system_halted (migración 0061).
//
// GAP que cierra: `agent_enabled` (0015) es un kill switch que SOLO gatea
// generate-response. Con el agente "apagado" por ese switch, process-inbound
// seguía clasificando con Haiku, dreams-run seguía destilando, evaluate-outcomes
// seguía evaluando con graders LLM, follow-up-scan seguía corriendo la sesión
// CMA completa por cada seguimiento, y publish-to-kommo seguía entregando
// drafts ya aprobados por WhatsApp/Instagram. Un operador que apaga el agente
// en una emergencia espera que se corte TODO: el gasto en proveedores de IA
// Y los mensajes salientes automáticos. `system_halted` es ese freno único,
// chequeado lo antes posible en cada una de las seis funciones.
//
// Por qué un solo archivo y no seis copias del `if`: seis copias de una
// condición de apagado es exactamente cómo una de ellas se queda sin
// actualizar el día que el chequeo tenga que cambiar (agregar un motivo,
// un timestamp, loguear distinto). Acá vive una sola vez.
//
// Dos formas de consultarlo, según lo que la función YA hace hoy:
//   - `isHaltedRow(row)` — process-inbound, generate-response y
//     publish-to-kommo YA leen una fila de kommo_publish_config en la misma
//     invocación (para agent_enabled, filtros, publishing_enabled...).
//     Agregan "system_halted" a ESE select existente y pasan la fila acá.
//     Costo: cero round-trips extra.
//   - `isSystemHalted(supabase)` — dreams-run, evaluate-outcomes y
//     follow-up-scan no tocan kommo_publish_config para nada más. Esta
//     función hace la consulta y la cachea 60s en module scope, el mismo
//     idioma de TTL que `_shared/config.ts`, para que un cron que dispare
//     varias corridas mientras el isolate sigue caliente no repita la query.
//
// Fail-open en los dos casos: columna ausente (pre-migración), valor no
// booleano, fila nula o error de red → false (no bloquea). El switch nuevo
// nunca puede convertirse en un apagón accidental por un fallo de lectura.

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

/**
 * Interpretación pura: true SOLO si el valor es exactamente `true`. Cualquier
 * otra cosa —undefined, null, "true" (string), 1, columna ausente— es
 * fail-open y NO bloquea. Es la única función que decide qué cuenta como
 * "apagado"; todo lo demás en este archivo delega acá.
 */
export function isHaltedValue(raw: unknown): boolean {
  return raw === true;
}

/**
 * Azúcar para funciones que ya leyeron una fila de kommo_publish_config en
 * esta invocación. `row` puede ser null/undefined (config ausente, error de
 * red ya manejado por el llamador) — fail-open a false.
 */
export function isHaltedRow(row: { system_halted?: unknown } | null | undefined): boolean {
  return isHaltedValue(row?.system_halted);
}

const HALT_TTL_MS = 60_000; // mismo TTL que _shared/config.ts
let cache: { value: boolean; loadedAt: number } | null = null;

/**
 * Para funciones que HOY no leen kommo_publish_config (dreams-run,
 * evaluate-outcomes, follow-up-scan). Cachea 60s en module scope — sin esto,
 * cada una repetiría su propia query suelta sin cache, que es justo lo que
 * hacía Cusica-Agente (tres copias, cada una golpeando la tabla en cada
 * invocación). Fail-open ante error: no bloquea el pipeline por un fallo de
 * lectura de config.
 */
export async function isSystemHalted(supabase: SupabaseClient | any): Promise<boolean> {
  if (cache && Date.now() - cache.loadedAt < HALT_TTL_MS) {
    return cache.value;
  }
  const { data, error } = await supabase
    .from("kommo_publish_config")
    .select("system_halted")
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.warn("isSystemHalted: error leyendo config — fail-open (false):", error.message);
    cache = { value: false, loadedAt: Date.now() };
    return false;
  }
  const value = isHaltedRow(data);
  cache = { value, loadedAt: Date.now() };
  return value;
}

/** SOLO para tests: fuerza a que el próximo isSystemHalted() vuelva a consultar. */
export function resetHaltCacheForTests(): void {
  cache = null;
}

/**
 * Respuesta estándar cuando el switch está en true. Status 200 — apagado no
 * es un error, es una decisión del operador. `{ ok: true, halted: true }` es
 * el núcleo fijo en las seis funciones (grepable en logs); `extra` deja que
 * cada una agregue los campos de SU propio contrato (picked, published,
 * processed...) para no romper a quien ya parsea esa respuesta.
 */
export function haltedResponse(extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: true, halted: true, ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Una sola línea de log, mismo formato en las seis funciones. console.log
 * (nunca console.error): el operador decidió esto a propósito, no es un fallo.
 */
export function logHalted(fnName: string): void {
  console.log(`[system_halted] ${fnName}: apagado total activo — salgo sin trabajar.`);
}
