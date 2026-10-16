// Correr con: deno test supabase/functions/_shared/outcome-retry.test.ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { errorAttemptsOf, MAX_ERROR_ATTEMPTS, shouldEvaluate } from "./outcome-retry.ts";

Deno.test("sin fila → se evalúa; con score → no (salvo mutable)", () => {
  assertEquals(shouldEvaluate(undefined, false), true);
  assertEquals(shouldEvaluate({ score: 0.7, metadata: { grader_model: "m" } }, false), false);
  assertEquals(shouldEvaluate({ score: 0, metadata: {} }, true), true);
});

Deno.test("fila de ERROR vieja (sin contador) se reintenta: es el caso del 400 de schema", () => {
  const old = { score: null, metadata: { error: true } };
  assertEquals(errorAttemptsOf(old), 1);
  assertEquals(shouldEvaluate(old, false), true);
});

Deno.test("una fila de ERROR deja de reintentarse al llegar al tope", () => {
  const at = (n: number) => ({ score: null, metadata: { error: true, error_attempts: n } });
  assertEquals(shouldEvaluate(at(MAX_ERROR_ATTEMPTS - 1), false), true);
  assertEquals(shouldEvaluate(at(MAX_ERROR_ATTEMPTS), false), false);
  assertEquals(errorAttemptsOf(at(2)), 2);
});

Deno.test("score NULL sin marca de error no es una fila de ERROR", () => {
  assertEquals(shouldEvaluate({ score: null, metadata: null }, false), false);
  assertEquals(errorAttemptsOf({ score: null, metadata: null }), 0);
  assertEquals(errorAttemptsOf(undefined), 0);
});
