// _shared/backfill-positions.test.ts
// Deno tests del bucle que rellena kommo_pipeline_id / kommo_stage_id de los
// leads existentes recorriendo /api/v4/leads por páginas.
//
// Correr con: deno test --allow-read supabase/functions/_shared/backfill-positions.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { LeaseLostError, runPositionsBackfill, type BackfillDeps, type BackfillProgress } from "./backfill-positions.ts";
import type { KommoLeadPosition } from "./kommo.ts";

function lead(id: number): KommoLeadPosition {
  return { id, status_id: 10, pipeline_id: 1 };
}

/** Deps de mentira: `pages[i]` es la página i+1; guarda cada save() en `saved`. */
function fakeDeps(
  pages: Array<{ leads: KommoLeadPosition[]; hasMore: boolean } | Error>,
  opts: {
    clock?: { t: number };
    applyReturns?: number;
    missing?: number;
    finalizeError?: Error;
    /** El save número N (1-based) y los siguientes lanzan LeaseLostError (otro worker es el dueño). */
    leaseLostFromSave?: number;
  } = {},
) {
  const saved: BackfillProgress[] = [];
  const attemptedSaves: BackfillProgress[] = [];
  const fetched: number[] = [];
  const slept: number[] = [];
  const finalized: number[] = [];
  const readAts: number[] = [];
  const clock = opts.clock ?? { t: 0 };
  const deps: BackfillDeps = {
    fetchPage: (page) => {
      fetched.push(page);
      const p = pages[page - 1];
      if (p instanceof Error) return Promise.reject(p);
      return Promise.resolve({ ...p, readAtMs: 1000 + page });
    },
    apply: (leads, readAtMs) => {
      readAts.push(readAtMs);
      return Promise.resolve(opts.applyReturns ?? leads.length);
    },
    finalize: () => {
      finalized.push(fetched.length);
      return opts.finalizeError ? Promise.reject(opts.finalizeError) : Promise.resolve(opts.missing ?? 0);
    },
    save: (p) => {
      attemptedSaves.push(p);
      if (opts.leaseLostFromSave && attemptedSaves.length >= opts.leaseLostFromSave) {
        return Promise.reject(new LeaseLostError());
      }
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
  return { deps, saved, attemptedSaves, fetched, slept, finalized, readAts, clock };
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
  assertEquals(r, { status: "done", nextPage: 3, scanned: 3, updated: 3, missing: 0 });
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
  assertEquals(r, { status: "done", nextPage: 4, scanned: 501, updated: 121, missing: 0 });
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

Deno.test("runPositionsBackfill: finaliza (marca los no vistos) SOLO al agotar las páginas", async () => {
  const { deps, finalized } = fakeDeps(
    [
      { leads: [lead(1)], hasMore: true },
      { leads: [lead(2)], hasMore: false },
    ],
    { missing: 4 },
  );
  const r = await runPositionsBackfill(START, deps, OPTS);
  assertEquals(finalized, [2]); // una vez, tras la última página
  assertEquals(r.missing, 4);
});

Deno.test("runPositionsBackfill: pausado por presupuesto NO finaliza (un recorrido parcial no puede declarar leads inexistentes)", async () => {
  const { deps, finalized } = fakeDeps(
    [
      { leads: [lead(1)], hasMore: true },
      { leads: [lead(2)], hasMore: true },
      { leads: [lead(3)], hasMore: true },
    ],
    { clock: { t: 0 } },
  );
  const r = await runPositionsBackfill(START, deps, { budgetMs: 400, pauseMs: 250 });
  assertEquals(r.status, "pending");
  assertEquals(finalized, []);
});

Deno.test("runPositionsBackfill: si finalize falla queda 'failed' (no 'done') para reintentar", async () => {
  const { deps, saved } = fakeDeps([{ leads: [lead(1)], hasMore: false }], { finalizeError: new Error("mark_kommo_missing_leads: boom") });
  const r = await runPositionsBackfill(START, deps, OPTS);
  assertEquals(r.status, "failed");
  assertEquals(saved.at(-1)?.error, "mark_kommo_missing_leads: boom");
});

Deno.test("runPositionsBackfill: cada página se aplica con el instante en que se PIDIÓ (no pisa un webhook más nuevo)", async () => {
  const { deps, readAts } = fakeDeps([
    { leads: [lead(1)], hasMore: true },
    { leads: [lead(2)], hasMore: false },
  ]);
  await runPositionsBackfill(START, deps, OPTS);
  assertEquals(readAts, [1001, 1002]);
});

Deno.test("runPositionsBackfill: lease perdido al guardar → PARA sin pedir más páginas ni guardar 'failed' (no pisa al nuevo dueño)", async () => {
  const pages = [1, 2, 3, 4].map((i) => ({ leads: [lead(i)], hasMore: i < 4 }));
  const { deps, saved, attemptedSaves, fetched } = fakeDeps(pages, { leaseLostFromSave: 2 });
  const r = await runPositionsBackfill(START, deps, OPTS);
  assertEquals(fetched, [1, 2], "tras perder el lease no se lee ninguna página más");
  assertEquals(saved.map((p) => p.nextPage), [2], "solo quedó guardado lo que se guardó siendo dueño");
  assertEquals(attemptedSaves.length, 2, "no se intenta guardar un 'failed' después de perder el lease");
  assertEquals(r.status, "failed");
  assertEquals(r.error, new LeaseLostError().message);
});

Deno.test("runPositionsBackfill: lease perdido durante finalize (el latido no pudo renovar) → no guarda 'done' ni 'failed'", async () => {
  const { deps, saved, attemptedSaves } = fakeDeps([{ leads: [lead(1)], hasMore: false }], {
    finalizeError: new LeaseLostError(),
  });
  const r = await runPositionsBackfill(START, deps, OPTS);
  assertEquals(attemptedSaves.length, 0);
  assertEquals(saved.length, 0);
  assertEquals(r.status, "failed");
});
