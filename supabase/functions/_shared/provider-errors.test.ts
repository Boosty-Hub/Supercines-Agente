// _shared/provider-errors.test.ts
// Deno test para isCreditError(). Correr con: deno test supabase/functions/_shared/provider-errors.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { isCreditError } from "./provider-errors.ts";

Deno.test("anthropic 400 + 'credit balance' → true", () => {
  assertEquals(
    isCreditError("anthropic", 400, JSON.stringify({ error: { message: "Your credit balance is too low to access the Anthropic API." } })),
    true,
  );
});

Deno.test("anthropic 429 (rate limit) → false, aunque el mensaje mencione crédito", () => {
  // 429 es rate limit — un tipo de error completamente distinto. NUNCA debe
  // disparar la detección de crédito agotado, incluso si el body menciona
  // "credit balance" por accidente.
  assertEquals(
    isCreditError("anthropic", 429, JSON.stringify({ error: { message: "credit balance low, rate limited" } })),
    false,
  );
});

Deno.test("anthropic 400 con otro mensaje (no crédito) → false", () => {
  assertEquals(
    isCreditError("anthropic", 400, JSON.stringify({ error: { message: "messages: roles must alternate between \"user\" and \"assistant\"" } })),
    false,
  );
});

Deno.test("openai 429 + 'insufficient_quota' → true", () => {
  assertEquals(
    isCreditError("openai", 429, JSON.stringify({ error: { message: "You exceeded your current quota", type: "insufficient_quota" } })),
    true,
  );
});

Deno.test("openai 400 → false, aunque el mensaje mencione insufficient_quota", () => {
  assertEquals(
    isCreditError("openai", 400, JSON.stringify({ error: { message: "insufficient_quota" } })),
    false,
  );
});
