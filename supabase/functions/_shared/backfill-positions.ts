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
//  - Al agotar las páginas (recorrido COMPLETO desde la 1, porque el claim nunca
//    rebobina uno en curso) llama a `finalize`: ahí la base marca los leads que
//    Kommo no devolvió (borrados allá). Si finalize falla queda 'failed' y se
//    reintenta sin perder lo visto.

import type { KommoLeadPosition } from "./kommo.ts";

export type BackfillStatus = "running" | "pending" | "done" | "failed";

export type BackfillProgress = {
  status: BackfillStatus;
  nextPage: number;
  scanned: number;
  updated: number;
  error?: string;
  /** Leads marcados «no existe en Kommo» al cerrar el recorrido (solo en 'done'). */
  missing?: number;
};

export type BackfillStart = { nextPage: number; scanned: number; updated: number };

export type BackfillDeps = {
  fetchPage(page: number): Promise<{ leads: KommoLeadPosition[]; hasMore: boolean }>;
  /** Aplica las posiciones en la base; devuelve cuántos leads CAMBIARON. */
  apply(leads: KommoLeadPosition[]): Promise<number>;
  /** Recorrido completo: marca los leads locales que Kommo no devolvió. Devuelve cuántos. */
  finalize(): Promise<number>;
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
        const missing = await deps.finalize();
        const done: BackfillProgress = { status: "done", nextPage, scanned, updated, missing };
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
