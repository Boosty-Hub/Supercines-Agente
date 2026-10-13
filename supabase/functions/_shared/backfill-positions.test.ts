// _shared/backfill-positions.test.ts
// Deno tests del bucle que rellena kommo_pipeline_id / kommo_stage_id de los
// leads existentes recorriendo /api/v4/leads por páginas.
//
// Correr con: deno test --allow-read supabase/functions/_shared/backfill-positions.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { runPositionsBackfill, type BackfillDeps, type BackfillProgress } from "./backfill-positions.ts";
import type { KommoLeadPosition } from "./kommo.ts";

function lead(id: number): KommoLeadPosition {
  return { id, status_id: 10, pipeline_id: 1 };
}

/** Deps de mentira: `pages[i]` es la página i+1; guarda cada save() en `saved`. */
function fakeDeps(
  pages: Array<{ leads: KommoLeadPosition[]; hasMore: boolean } | Error>,
  opts: { clock?: { t: number }; applyReturns?: number } = {},
) {
  const saved: BackfillProgress[] = [];
  const fetched: number[] = [];
  const slept: number[] = [];
  const clock = opts.clock ?? { t: 0 };
  const deps: BackfillDeps = {
    fetchPage: (page) => {
      fetched.push(page);
      const p = pages[page - 1];
      if (p instanceof Error) return Promise.reject(p);
      return Promise.resolve(p);
    },
    apply: (leads) => Promise.resolve(opts.applyReturns ?? leads.length),
    save: (p) => {
      saved.push(p);
      return Promise.resolve();
    },
    now: () => clock.t,
    sleep: (ms) => {
      slept.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
  };
  return { deps, saved, fetched, slept, clock };
}

const START = { nextPage: 1, scanned: 0, updated: 0 };
const OPTS = { budgetMs: 100_000, pauseMs: 250 };

Deno.test("runPositionsBackfill: recorre todas las páginas y termina en 'done'", async () => {
  const { deps, saved, fetched } = fakeDeps([
    { leads: [lead(1), lead(2)], hasMore: true },
    { leads: [lead(3)], hasMore: false },
  ]);
  const r = await runPositionsBackfill(START, deps, OPTS);
  assertEquals(fetched, [1, 2]);
  assertEquals(r, { status: "done", nextPage: 3, scanned: 3, updated: 3 });
  // Progreso guardado tras CADA página: si el worker muere, se retoma ahí.
  assertEquals(saved.map((s) => [s.status, s.nextPage, s.scanned]), [
    ["running", 2, 2],
    ["done", 3, 3],
  ]);
});

Deno.test("runPositionsBackfill: reanuda desde la página guardada y suma al acumulado", async () => {
  const { deps, fetched } = fakeDeps([
    { leads: [], hasMore: false },
    { leads: [], hasMore: false },
    { leads: [lead(9)], hasMore: false },
  ]);
  const r = await runPositionsBackfill({ nextPage: 3, scanned: 500, updated: 120 }, deps, OPTS);
  assertEquals(fetched, [3]);
  assertEquals(r, { status: "done", nextPage: 4, scanned: 501, updated: 121 });
});

Deno.test("runPositionsBackfill: 'updated' cuenta solo lo que la base realmente cambió", async () => {
  const { deps } = fakeDeps([{ leads: [lead(1), lead(2), lead(3)], hasMore: false }], { applyReturns: 1 });
  const r = await runPositionsBackfill(START, deps, OPTS);
  assertEquals(r.scanned, 3);
  assertEquals(r.updated, 1);
});

Deno.test("runPositionsBackfill: respeta el rate limit con una pausa entre páginas (no después de la última)", async () => {
  const { deps, slept } = fakeDeps([
    { leads: [lead(1)], hasMore: true },
    { leads: [lead(2)], hasMore: true },
    { leads: [lead(3)], hasMore: false },
  ]);
  await runPositionsBackfill(START, deps, OPTS);
  assertEquals(slept, [250, 250]);
});

Deno.test("runPositionsBackfill: al agotar el presupuesto de tiempo deja 'pending' y retoma en la siguiente", async () => {
  const { deps, saved } = fakeDeps(
    [
      { leads: [lead(1)], hasMore: true },
      { leads: [lead(2)], hasMore: true },
      { leads: [lead(3)], hasMore: true },
    ],
    { clock: { t: 0 } },
  );
  const r = await runPositionsBackfill(START, deps, { budgetMs: 400, pauseMs: 250 });
  // pág 1 (t=0) → pausa a 250 → pág 2 (t=250 < 400) → pausa a 500 → se pasó.
  assertEquals(r, { status: "pending", nextPage: 3, scanned: 2, updated: 2 });
  assertEquals(saved.at(-1)?.status, "pending");
});

Deno.test("runPositionsBackfill: un error de Kommo deja 'failed' con el mensaje y el progreso intacto", async () => {
  const { deps, saved } = fakeDeps([{ leads: [lead(1)], hasMore: true }, new Error("fetch leads page 2: 401 unauthorized")]);
  const r = await runPositionsBackfill(START, deps, OPTS);
  assertEquals(r.status, "failed");
  assertEquals(r.nextPage, 2); // la página 2 NO se contó: se reintenta
  assertEquals(r.scanned, 1);
  const last = saved.at(-1)!;
  assertEquals(last.status, "failed");
  assertEquals(last.error, "fetch leads page 2: 401 unauthorized");
});
