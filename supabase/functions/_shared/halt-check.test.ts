// _shared/halt-check.test.ts
// Deno test para _shared/halt.ts — el kill switch total (system_halted).
// Correr con: deno test --allow-read supabase/functions/_shared/halt-check.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  isHaltedValue,
  isHaltedRow,
  isSystemHalted,
  resetHaltCacheForTests,
  haltedResponse,
} from "./halt.ts";

// ─── isHaltedValue ───────────────────────────────────────────────────────────

Deno.test("isHaltedValue: true estricto → true", () => {
  assertEquals(isHaltedValue(true), true);
});

Deno.test("isHaltedValue: false → false", () => {
  assertEquals(isHaltedValue(false), false);
});

Deno.test("isHaltedValue: undefined/null (columna ausente, pre-migración) → false, fail-open", () => {
  assertEquals(isHaltedValue(undefined), false);
  assertEquals(isHaltedValue(null), false);
});

Deno.test("isHaltedValue: valores no booleanos (string \"true\", 1, {}) → false, no se cuela nada raro", () => {
  assertEquals(isHaltedValue("true"), false);
  assertEquals(isHaltedValue(1), false);
  assertEquals(isHaltedValue({}), false);
});

// ─── isHaltedRow ─────────────────────────────────────────────────────────────

Deno.test("isHaltedRow: fila con system_halted=true → true", () => {
  assertEquals(isHaltedRow({ system_halted: true }), true);
});

Deno.test("isHaltedRow: fila con system_halted=false → false", () => {
  assertEquals(isHaltedRow({ system_halted: false }), false);
});

Deno.test("isHaltedRow: fila null/undefined (config ausente) → false, fail-open", () => {
  assertEquals(isHaltedRow(null), false);
  assertEquals(isHaltedRow(undefined), false);
});

Deno.test("isHaltedRow: fila sin la columna (pre-migración) → false, fail-open", () => {
  assertEquals(isHaltedRow({}), false);
});

// ─── haltedResponse ──────────────────────────────────────────────────────────

Deno.test("haltedResponse: sin extra → {ok:true, halted:true}, status 200", async () => {
  const res = haltedResponse();
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json");
  const body = await res.json();
  assertEquals(body, { ok: true, halted: true });
});

Deno.test("haltedResponse: con extra → se mezcla manteniendo ok:true y halted:true", async () => {
  const res = haltedResponse({ picked: null, processed: 0 });
  const body = await res.json();
  assertEquals(body, { ok: true, halted: true, picked: null, processed: 0 });
});

// ─── isSystemHalted (con cliente Supabase falso) ────────────────────────────

/**
 * Duck-type mínimo de lo que isSystemHalted() usa realmente:
 * .from(table).select(cols).eq(col, val).maybeSingle(). `calls` cuenta
 * cuántas veces se llegó a pedir datos de verdad, para probar el cache.
 */
function fakeSupabase(result: { data?: unknown; error?: { message: string } | null }) {
  const state = { calls: 0 };
  const client = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: unknown) {
              return {
                maybeSingle: async () => {
                  state.calls++;
                  return result;
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, state };
}

Deno.test("isSystemHalted: system_halted=true en la fila → true", async () => {
  resetHaltCacheForTests();
  const { client } = fakeSupabase({ data: { system_halted: true }, error: null });
  assertEquals(await isSystemHalted(client), true);
});

Deno.test("isSystemHalted: system_halted=false → false", async () => {
  resetHaltCacheForTests();
  const { client } = fakeSupabase({ data: { system_halted: false }, error: null });
  assertEquals(await isSystemHalted(client), false);
});

Deno.test("isSystemHalted: fila null (config ausente) → false, fail-open", async () => {
  resetHaltCacheForTests();
  const { client } = fakeSupabase({ data: null, error: null });
  assertEquals(await isSystemHalted(client), false);
});

Deno.test("isSystemHalted: error de red/tabla no migrada → false, fail-open (no bloquea el pipeline)", async () => {
  resetHaltCacheForTests();
  const { client } = fakeSupabase({ data: null, error: { message: "column system_halted does not exist" } });
  assertEquals(await isSystemHalted(client), false);
});

Deno.test("isSystemHalted: cachea 60s — la segunda llamada NO vuelve a consultar", async () => {
  resetHaltCacheForTests();
  const { client, state } = fakeSupabase({ data: { system_halted: true }, error: null });
  const first = await isSystemHalted(client);
  const second = await isSystemHalted(client);
  assertEquals(first, true);
  assertEquals(second, true);
  assertEquals(state.calls, 1, "la segunda lectura debió venir del cache, no de una query nueva");
});

Deno.test("resetHaltCacheForTests: fuerza a re-consultar (el switch pudo cambiar entre corridas)", async () => {
  resetHaltCacheForTests();
  const on = fakeSupabase({ data: { system_halted: true }, error: null });
  assertEquals(await isSystemHalted(on.client), true);

  resetHaltCacheForTests();
  const off = fakeSupabase({ data: { system_halted: false }, error: null });
  assertEquals(await isSystemHalted(off.client), false);
  assertEquals(off.state.calls, 1, "sin el reset, seguiría devolviendo el valor cacheado (true)");
});
