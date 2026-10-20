// _shared/dreams-refresh.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/dreams-refresh.test.ts
//
// Revisión de c833dd4: un refresco de un dream ACTIVO saltaba la política de activación
// (DREAMS_AUTO_ACTIVATE) y BORRABA el original para siempre; además podía resucitar un dream
// que el operador borró o aprobó durante la corrida.
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  clampLearnings,
  MAX_LEARNINGS_PER_RUN,
  MAX_REFRESHES_PER_RUN,
  planLearningWrite,
  refreshesOf,
  toArchivePath,
} from "./dreams-refresh.ts";

const fm = (extra = "") => `---\ncategory: anti_pattern\noccurrences: 2\n${extra}---\n\n# t\n\nRegla.\n`;
const active = { id: "a1", path: "/dreams/daily/2026-10-10_00_sug_x.md", content: fm() };
const pending = { id: "p1", path: "/dreams-pending/daily/2026-10-10_00_sug_x.md", content: fm() };
const target = (d: { id: string; path: string }) => ({ id: d.id, path: d.path });

Deno.test("sin destino: nuevo, activo según la política", () => {
  for (const policyActive of [true, false]) {
    const p = planLearningWrite({ target: null, current: undefined, policyActive, refreshesSoFar: 0 });
    assert(p.action === "write");
    assertEquals(p.active, policyActive);
    assertEquals(p.replace, null);
    assertEquals(p.refreshes, null);
    assertEquals(p.occurrences, 1);
  }
});

Deno.test("refresco de un ACTIVO con política que NO lo activaría → pendiente con refreshes, el original NO se toca", () => {
  const p = planLearningWrite({ target: target(active), current: active, policyActive: false, refreshesSoFar: 0 });
  assert(p.action === "write");
  assertEquals(p.active, false);
  assertEquals(p.refreshes, "a1");
  assertEquals(p.replace, null);
  assertEquals(p.activeChanged, false);
  assertEquals(p.occurrences, 3);
});

Deno.test("un segundo refresco pendiente del mismo activo reemplaza al pendiente anterior (no se acumulan)", () => {
  const prev = { id: "p9", path: "/dreams-pending/daily/2026-10-11_00_sug_x.md", content: fm('refreshes: "a1"\n') };
  const p = planLearningWrite({ target: target(active), current: active, policyActive: false, refreshesSoFar: 0, pendingRefreshOf: prev });
  assert(p.action === "write");
  assertEquals(p.replace?.id, "p9");
  assertEquals(p.replace?.mode, "delete");
});

Deno.test("refresco de un ACTIVO con política que lo activa → activo, el original se ARCHIVA (nunca se borra) y se avisa", () => {
  const p = planLearningWrite({ target: target(active), current: active, policyActive: true, refreshesSoFar: 0 });
  assert(p.action === "write");
  assertEquals(p.active, true);
  assertEquals(p.replace?.mode, "archive");
  assertEquals(p.replace?.id, "a1");
  assertEquals(p.activeChanged, true);
});

Deno.test("refresco de un PENDIENTE: estado según la política; el pendiente viejo se reemplaza", () => {
  for (const policyActive of [true, false]) {
    const p = planLearningWrite({ target: target(pending), current: pending, policyActive, refreshesSoFar: 0 });
    assert(p.action === "write");
    assertEquals(p.active, policyActive);
    assertEquals(p.replace?.mode, "delete");
    assertEquals(p.activeChanged, false);
  }
});

Deno.test("refresco de un pendiente que ya refrescaba un activo: hereda refreshes y queda pendiente", () => {
  const pr = { ...pending, content: fm('refreshes: "a1"\n') };
  const p = planLearningWrite({ target: target(pr), current: pr, policyActive: true, refreshesSoFar: 0 });
  assert(p.action === "write");
  assertEquals(p.active, false);
  assertEquals(p.refreshes, "a1");
});

Deno.test("el destino se BORRÓ durante la corrida → se descarta (no se resucita)", () => {
  const p = planLearningWrite({ target: target(active), current: null, policyActive: true, refreshesSoFar: 0 });
  assertEquals(p, { action: "drop", reason: "target_gone" });
});

Deno.test("el destino se MOVIÓ durante la corrida (aprobado) → se decide con su ubicación ACTUAL", () => {
  const approved = { id: "p1", path: "/dreams/daily/2026-10-10_00_sug_x.md", content: fm() };
  const p = planLearningWrite({ target: target(pending), current: approved, policyActive: false, refreshesSoFar: 0 });
  assert(p.action === "write");
  assertEquals(p.active, false, "ahora es activo y la política no activaría: pendiente con refreshes");
  assertEquals(p.refreshes, "p1");
  assertEquals(p.replace, null);
});

Deno.test("el destino quedó archivado → se descarta", () => {
  const arch = { ...active, path: "/dreams-archive/daily/2026-10-10_00_sug_x.md" };
  assertEquals(planLearningWrite({ target: target(active), current: arch, policyActive: true, refreshesSoFar: 0 }).action, "drop");
});

Deno.test("tope de refrescos por corrida", () => {
  assertEquals(MAX_REFRESHES_PER_RUN, 3);
  const p = planLearningWrite({ target: target(active), current: active, policyActive: true, refreshesSoFar: 3 });
  assertEquals(p, { action: "drop", reason: "refresh_cap" });
  // un learning nuevo no cuenta contra ese tope
  assertEquals(planLearningWrite({ target: null, current: undefined, policyActive: true, refreshesSoFar: 3 }).action, "write");
});

Deno.test("tope de learnings por corrida (8) en código", () => {
  assertEquals(MAX_LEARNINGS_PER_RUN, 8);
  assertEquals(clampLearnings(Array.from({ length: 20 }, (_, i) => i)).length, 8);
  assertEquals(clampLearnings(undefined), []);
  assertEquals(clampLearnings("x" as unknown as number[]), []);
});

Deno.test("refreshesOf y toArchivePath", () => {
  assertEquals(refreshesOf(fm('refreshes: "a1"\n')), "a1");
  assertEquals(refreshesOf(fm("refreshes: a1\n")), "a1");
  assertEquals(refreshesOf(fm()), null);
  assertEquals(refreshesOf(fm('refreshes: "../x y"\n')), null, "solo ids con forma de id");
  assertEquals(toArchivePath("/dreams/daily/a.md"), "/dreams-archive/daily/a.md");
});
