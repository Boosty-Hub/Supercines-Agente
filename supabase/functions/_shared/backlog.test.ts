// _shared/backlog.test.ts
// Deno test para isStaleBacklog(). Correr con: deno test supabase/functions/_shared/backlog.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { isStaleBacklog } from "./backlog.ts";

const HOUR = 3600_000;
const NOW = Date.parse("2026-09-24T12:00:00.000Z");

Deno.test("mensaje de hace 30min con ventana de 1h → fresco", () => {
  assertEquals(isStaleBacklog(NOW - 30 * 60_000, NOW, 1), false);
});

Deno.test("mensaje de hace 2h con ventana de 1h → stale", () => {
  assertEquals(isStaleBacklog(NOW - 2 * HOUR, NOW, 1), true);
});

Deno.test("mensaje de hace 3 días con maxAgeHours=0 (sin límite) → nunca stale", () => {
  assertEquals(isStaleBacklog(NOW - 72 * HOUR, NOW, 0), false);
});

Deno.test("justo en el borde de la ventana (exactamente maxAgeHours) → no stale (corte estricto >)", () => {
  assertEquals(isStaleBacklog(NOW - 1 * HOUR, NOW, 1), false);
});

Deno.test("un segundo más allá del borde → stale", () => {
  assertEquals(isStaleBacklog(NOW - 1 * HOUR - 1000, NOW, 1), true);
});

Deno.test("timestamp inválido → fail-open, no bloquea la clasificación", () => {
  assertEquals(isStaleBacklog("no-es-una-fecha", NOW, 1), false);
});

Deno.test("maxAgeHours negativo (config corrupta) → tratado como sin límite", () => {
  assertEquals(isStaleBacklog(NOW - 72 * HOUR, NOW, -5), false);
});
