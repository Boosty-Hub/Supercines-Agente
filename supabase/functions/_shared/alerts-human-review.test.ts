// _shared/alerts-human-review.test.ts
// Deno test para shouldAlertHumanReview(). Correr con:
// deno test supabase/functions/_shared/alerts-human-review.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { shouldAlertHumanReview } from "./alerts-human-review.ts";

Deno.test("requires_human_review=true, ignored=false → alerta", () => {
  assertEquals(shouldAlertHumanReview({ requires_human_review: true, ignored: false }), true);
});

Deno.test("requires_human_review=true, ignored=true (canal silenciado, etc.) → NO alerta", () => {
  assertEquals(shouldAlertHumanReview({ requires_human_review: true, ignored: true }), false);
});

Deno.test("requires_human_review=false, ignored=false → NO alerta", () => {
  assertEquals(shouldAlertHumanReview({ requires_human_review: false, ignored: false }), false);
});

Deno.test("requires_human_review=false, ignored=true → NO alerta", () => {
  assertEquals(shouldAlertHumanReview({ requires_human_review: false, ignored: true }), false);
});

Deno.test("ignored ausente (undefined) se trata como no-ignorado → alerta si requires_human_review", () => {
  assertEquals(shouldAlertHumanReview({ requires_human_review: true }), true);
});

Deno.test("ignored null (fila vieja pre-migración) se trata como no-ignorado → alerta si requires_human_review", () => {
  assertEquals(shouldAlertHumanReview({ requires_human_review: true, ignored: null }), true);
});

Deno.test("requires_human_review ausente → NO alerta", () => {
  assertEquals(shouldAlertHumanReview({ ignored: false }), false);
});

Deno.test("requires_human_review null → NO alerta", () => {
  assertEquals(shouldAlertHumanReview({ requires_human_review: null, ignored: false }), false);
});
