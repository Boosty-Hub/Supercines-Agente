// _shared/ai-pricing.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/ai-pricing.test.ts
//
// Cubre la tarifa escalonada por largo de prompt (Haiku 5.5). La paridad con la
// copia web (web/src/lib/ai-pricing.ts) se verifica en supabase/tests/web-parity.test.ts.

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@^1.0.0";
import { AI_PRICING, costUsd, rateCardFor } from "./ai-pricing.ts";

const M = 1_000_000;

Deno.test("haiku 5.5: tarifa base ($0.10 in / $0.50 out) para prompts <= 100K", () => {
  // 100K tokens (el tope del escalón base) de input y de output.
  const c = costUsd({ model: "claude-haiku-5-5", inputTokens: 100_000, outputTokens: 100_000 });
  assertAlmostEquals(c, 0.1 * 0.1 + 0.5 * 0.1, 1e-6);
});

Deno.test("haiku 5.5: cache read 0.01, write 5m 0.125, write 1h 0.20 (base, por MTok)", () => {
  assertAlmostEquals(costUsd({ model: "claude-haiku-5-5", cacheReadTokens: 100_000 }), 0.01 * 0.1, 1e-6);
  assertAlmostEquals(costUsd({ model: "claude-haiku-5-5", cacheCreation5m: 100_000 }), 0.125 * 0.1, 1e-6);
  assertAlmostEquals(costUsd({ model: "claude-haiku-5-5", cacheCreation1h: 100_000 }), 0.2 * 0.1, 1e-6);
});

Deno.test("haiku 5.5: justo en 100.000 tokens de prompt sigue en la tarifa base", () => {
  const c = costUsd({ model: "claude-haiku-5-5", inputTokens: 100_000, outputTokens: M });
  assertAlmostEquals(c, (100_000 / M) * 0.1 + 0.5, 1e-6);
});

Deno.test("haiku 5.5: 100.001 tokens de prompt => TODA la request a la tarifa larga ($0.50 / $2.50)", () => {
  const c = costUsd({ model: "claude-haiku-5-5", inputTokens: 100_001, outputTokens: M });
  assertAlmostEquals(c, (100_001 / M) * 0.5 + 2.5, 1e-6);
});

Deno.test("haiku 5.5: el largo del prompt cuenta cache read + cache write, no solo input", () => {
  // 1 input + 100.000 cache read = 100.001 => tarifa larga en TODAS las categorías.
  const c = costUsd({ model: "claude-haiku-5-5", inputTokens: 1, cacheReadTokens: 100_000 });
  assertAlmostEquals(c, (1 / M) * 0.5 + (100_000 / M) * 0.05, 1e-6);
  const w = costUsd({ model: "claude-haiku-5-5", inputTokens: 1, cacheCreation1h: 100_000 });
  assertAlmostEquals(w, (1 / M) * 0.5 + (100_000 / M) * 1.0, 1e-6);
});

Deno.test("aggregated: un agregado de sesión CMA no se puede escalonar => tarifa base (cota inferior)", () => {
  const c = costUsd({ model: "claude-haiku-5-5", inputTokens: 500_000, outputTokens: 0, aggregated: true });
  assertAlmostEquals(c, (500_000 / M) * 0.1, 1e-6);
});

Deno.test("modelos sin tarifa larga ignoran el escalón (sonnet 4.6 es plano)", () => {
  const c = costUsd({ model: "claude-sonnet-4-6", inputTokens: 500_000 });
  assertAlmostEquals(c, (500_000 / M) * 3, 1e-6);
});

Deno.test("modelos históricos siguen valuados (costo de filas viejas no cambia)", () => {
  assertAlmostEquals(costUsd({ model: "claude-haiku-4-5", inputTokens: M, outputTokens: M }), 6, 1e-6);
  assertAlmostEquals(costUsd({ model: "claude-sonnet-4-6", inputTokens: M, outputTokens: M }), 18, 1e-6);
  assertAlmostEquals(costUsd({ model: "claude-opus-4-8", inputTokens: M, outputTokens: M }), 30, 1e-6);
});

Deno.test("modelo desconocido => 0 (fail-open)", () => {
  assertEquals(costUsd({ model: "claude-nunca-visto", inputTokens: M }), 0);
});

Deno.test("override plano aplica a la tarifa base; el override de longContext reemplaza el bloque entero", () => {
  const base = costUsd({
    model: "claude-haiku-5-5", inputTokens: 50_000,
    pricingOverride: { "claude-haiku-5-5": { input: 0.2 } },
  });
  assertAlmostEquals(base, 0.01, 1e-6);
  const long = costUsd({
    model: "claude-haiku-5-5", inputTokens: 200_000,
    pricingOverride: { "claude-haiku-5-5": { longContext: { aboveTokens: 100_000, input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 } } },
  });
  assertAlmostEquals(long, 0.2, 1e-6);
});

Deno.test("rateCardFor devuelve la tarifa correcta según el prompt", () => {
  const p = AI_PRICING["claude-haiku-5-5"];
  assertEquals(rateCardFor(p, 100_000).input, 0.1);
  assertEquals(rateCardFor(p, 100_001).input, 0.5);
  assertEquals(rateCardFor(p, undefined).input, 0.1);
});
