// _shared/claim-batch.test.ts
// Deno test para evaluateClaim() — la interpretación pura del resultado de
// la RPC claim_message_batch (migración 0060).
// Correr con: deno test --allow-read supabase/functions/_shared/claim-batch.test.ts

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { evaluateClaim } from "./claim-batch.ts";

Deno.test("gana el lote completo → won=true, sin needsRelease ni mensaje", () => {
  const r = evaluateClaim(3, null, 3);
  assertEquals(r, { won: true });
});

Deno.test("gana un lote de una sola fila → won=true (caso más común)", () => {
  const r = evaluateClaim(1, null, 1);
  assertEquals(r, { won: true });
});

Deno.test("pierde TODO el lote (otra invocación lo tomó primero) → needsRelease=false, no hay nada que liberar", () => {
  const r = evaluateClaim(0, null, 3);
  assertEquals(r.won, false);
  if (r.won) throw new Error("unreachable");
  assertEquals(r.needsRelease, false);
  assertStringIncludes(r.message, "0/3");
});

Deno.test("pierde PARTE del lote → needsRelease=true, las filas que sí marcó quedan huérfanas si no se liberan", () => {
  const r = evaluateClaim(2, null, 5);
  assertEquals(r.won, false);
  if (r.won) throw new Error("unreachable");
  assertEquals(r.needsRelease, true);
  assertStringIncludes(r.message, "2/5");
});

Deno.test("claimedCount null (RPC no devolvió nada) sin error → se trata como 0, perdido", () => {
  const r = evaluateClaim(null, null, 4);
  assertEquals(r.won, false);
  if (r.won) throw new Error("unreachable");
  assertEquals(r.needsRelease, false);
  assertStringIncludes(r.message, "0/4");
});

Deno.test("claimedCount undefined sin error → igual que null, se trata como 0", () => {
  const r = evaluateClaim(undefined, null, 2);
  assertEquals(r.won, false);
  if (r.won) throw new Error("unreachable");
  assertEquals(r.needsRelease, false);
});

Deno.test("la RPC devuelve error → won=false, needsRelease=false SIEMPRE (una sentencia SQL que falla no comprometió nada)", () => {
  const r = evaluateClaim(null, { message: "permission denied for function claim_message_batch" }, 3);
  assertEquals(r.won, false);
  if (r.won) throw new Error("unreachable");
  assertEquals(r.needsRelease, false);
  assertStringIncludes(r.message, "permission denied");
});

Deno.test("error presente PERO con un claimedCount de otra llamada colgado → igual needsRelease=false (el error manda)", () => {
  // No debería pasar en la práctica (si hay error, el driver no debería
  // traer data), pero si algún cliente HTTP rarísimo devolviera ambos, el
  // error tiene que ganar: no sabemos si esa cuenta es confiable.
  const r = evaluateClaim(2, { message: "timeout" }, 5);
  assertEquals(r.won, false);
  if (r.won) throw new Error("unreachable");
  assertEquals(r.needsRelease, false);
});
