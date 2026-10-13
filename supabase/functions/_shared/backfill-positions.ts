// _shared/backfill-positions.ts
// Bucle reanudable que rellena `leads.kommo_pipeline_id` / `kommo_stage_id` de
// los leads que ya existían, recorriendo GET /api/v4/leads por páginas.
//
// Sin I/O propio: todo entra por `deps`, así se testea sin red ni base y
// sync-pipelines/index.ts queda como pegamento (claim del lease, deps reales).
//
// Garantías:
//  - Progreso persistido tras CADA página: si el worker muere (o el runtime
//    mata la función) se retoma en la página siguiente, nunca desde cero.
//  - Presupuesto de tiempo: una invocación no corre más de `budgetMs`; lo que
//    falte queda 'pending' para la próxima (el cron pasa cada 10 min).
//  - Rate limit: pausa de `pauseMs` entre páginas. Kommo permite ~7 req/s por
//    cuenta y se comparten con el webhook, el agente y el panel; ~4 req/s deja
//    margen. El 429 puntual lo absorbe fetchLeadsPositionsPage (con reintentos).
//  - Un error NO avanza el cursor: la página fallida se reintenta entera.

import type { KommoLeadPosition } from "./kommo.ts";

export type BackfillStatus = "running" | "pending" | "done" | "failed";

export type BackfillProgress = {
  status: BackfillStatus;
  nextPage: number;
  scanned: number;
  updated: number;
  error?: string;
};

export type BackfillStart = { nextPage: number; scanned: number; updated: number };

export type BackfillDeps = {
  fetchPage(page: number): Promise<{ leads: KommoLeadPosition[]; hasMore: boolean }>;
  /** Aplica las posiciones en la base; devuelve cuántos leads CAMBIARON. */
  apply(leads: KommoLeadPosition[]): Promise<number>;
  save(progress: BackfillProgress): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
};

export async function runPositionsBackfill(
  start: BackfillStart,
  deps: BackfillDeps,
  opts: { budgetMs: number; pauseMs: number },
): Promise<BackfillProgress> {
  const deadline = deps.now() + opts.budgetMs;
  let { nextPage, scanned, updated } = start;

  try {
    for (;;) {
      const { leads, hasMore } = await deps.fetchPage(nextPage);
      if (leads.length > 0) updated += await deps.apply(leads);
      scanned += leads.length;
      nextPage += 1;

      if (!hasMore) {
        const done: BackfillProgress = { status: "done", nextPage, scanned, updated };
        await deps.save(done);
        return done;
      }

      await deps.save({ status: "running", nextPage, scanned, updated });
      await deps.sleep(opts.pauseMs);

      if (deps.now() >= deadline) {
        const paused: BackfillProgress = { status: "pending", nextPage, scanned, updated };
        await deps.save(paused);
        return paused;
      }
    }
  } catch (e) {
    const failed: BackfillProgress = {
      status: "failed",
      nextPage,
      scanned,
      updated,
      error: e instanceof Error ? e.message : String(e),
    };
    await deps.save(failed).catch((se) => console.error("backfill: no se pudo guardar el fallo:", se));
    return failed;
  }
}
