// _shared/provider-errors.test.ts
// Deno test para isCreditError(). Correr con: deno test supabase/functions/_shared/provider-errors.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { isCreditError, isTransientProviderError } from "./provider-errors.ts";

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

Deno.test("isTransientProviderError: 429, 5xx (incluido 529) y red son transitorios", () => {
  assertEquals(isTransientProviderError({ status: 429, message: "rate limit" }), true);
  assertEquals(isTransientProviderError({ status: 500, message: "boom" }), true);
  assertEquals(isTransientProviderError({ status: 529, message: "overloaded" }), true);
  assertEquals(isTransientProviderError({ name: "APIConnectionError", message: "Connection error." }), true);
  assertEquals(isTransientProviderError({ name: "APIConnectionTimeoutError", message: "Request timed out." }), true);
  assertEquals(isTransientProviderError(new Error("fetch failed")), true);
});

Deno.test("isTransientProviderError: la falta de crédito es transitoria (se arregla recargando)", () => {
  assertEquals(isTransientProviderError({ status: 400, message: "Your credit balance is too low" }), true);
});

Deno.test("isTransientProviderError: 4xx propios y errores de parseo NO lo son", () => {
  assertEquals(isTransientProviderError({ status: 400, message: "invalid_request_error: bad schema" }), false);
  assertEquals(isTransientProviderError({ status: 401, message: "invalid x-api-key" }), false);
  assertEquals(isTransientProviderError(new Error("no text in response")), false);
  assertEquals(isTransientProviderError(new SyntaxError("Unexpected token")), false);
  assertEquals(isTransientProviderError(null), false);
  assertEquals(isTransientProviderError("boom"), false);
});
