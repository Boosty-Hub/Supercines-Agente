// Correr con: deno test supabase/functions/_shared/outcomes-regression.test.ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { detectRegressions, judgeOf, type OutcomeSample } from "./outcomes-regression.ts";

const rows = (n: number, score: number, model: string | null, extra: Partial<OutcomeSample> = {}): OutcomeSample[] =>
  Array.from({ length: n }, () => ({
    grader_id: "g1",
    slug: "voice_match",
    source: "llm_judge",
    score,
    metadata: model ? { grader_model: model } : {},
    ...extra,
  }));

Deno.test("cambio de juez (4.5 → 5.5) NO es una regresión: sin baseline del mismo juez no alerta", () => {
  // Caso real LAM: juez 4.5 daba 0.68, juez 5.5 da 0.30 con el mismo agente.
  const baseline = rows(40, 0.68, "claude-haiku-4-5");
  const recent = rows(20, 0.3, "claude-haiku-5-5");
  assertEquals(detectRegressions(recent, baseline), []);
});

Deno.test("filas viejas sin grader_model no sirven de baseline", () => {
  assertEquals(detectRegressions(rows(20, 0.3, "claude-haiku-5-5"), rows(40, 0.68, null)), []);
});

Deno.test("con el MISMO juez una caída real sí alerta", () => {
  const out = detectRegressions(rows(10, 0.3, "claude-haiku-5-5"), rows(30, 0.6, "claude-haiku-5-5"));
  assertEquals(out.length, 1);
  assertEquals(out[0].judge, "claude-haiku-5-5");
  assertEquals(out[0].recentCount, 10);
});

Deno.test("n insuficiente en cualquiera de las ventanas → no alerta", () => {
  assertEquals(detectRegressions(rows(4, 0.1, "m"), rows(30, 0.9, "m")), []);
  assertEquals(detectRegressions(rows(10, 0.1, "m"), rows(4, 0.9, "m")), []);
});

Deno.test("graders automáticos se comparan siempre (no tienen juez), aun sin grader_model", () => {
  const auto = (n: number, s: number) => rows(n, s, null, { source: "automatic", slug: "length_appropriate", grader_id: "g2" });
  const out = detectRegressions(auto(10, 0.2), auto(10, 0.9));
  assertEquals(out.map((r) => [r.slug, r.judge]), [["length_appropriate", "automatic"]]);
  assertEquals(judgeOf({ grader_id: "x", score: 1, source: "automatic" }), "automatic");
});

Deno.test("mezcla de jueces en la ventana reciente: cada uno contra su propio baseline", () => {
  const recent = [...rows(10, 0.3, "claude-haiku-5-5"), ...rows(10, 0.65, "claude-haiku-4-5")];
  const baseline = [...rows(10, 0.33, "claude-haiku-5-5"), ...rows(10, 0.68, "claude-haiku-4-5")];
  assertEquals(detectRegressions(recent, baseline), []);
});
