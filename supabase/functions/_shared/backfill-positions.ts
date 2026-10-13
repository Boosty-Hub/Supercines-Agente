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
//    rebobina uno en curso) llama a `finalize`: los leads que no aparecieron son
//    solo CANDIDATOS (la paginación por offset se corre si borran un lead durante
//    la lectura) y se verifican por id en Kommo antes de marcar a ninguno. Si
//    finalize falla queda 'failed' y se reintenta sin perder lo visto.
//  - Dueño del lease: `save` (y el latido de finalize) solo escriben si este worker sigue
//    siendo el dueño (lease_token, 0061). Si otro reclamó el recorrido tras vencer el
//    lease, lanzan LeaseLostError y el bucle PARA sin escribir nada más: ni el progreso ni
//    un 'failed' que pisaría el recorrido del nuevo dueño.

import type { KommoLeadPosition, KommoLeadsRead } from "./kommo.ts";

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

/**
 * Este worker ya no es el dueño del lease del recorrido (venció y otro lo reclamó). Lo
 * lanzan `save` / el latido cuando la base rechaza el token; el bucle para sin escribir.
 */
export class LeaseLostError extends Error {
  constructor(message = "lease perdido: otro worker tomó el recorrido") {
    super(message);
    this.name = "LeaseLostError";
  }
}

export type BackfillDeps = {
  fetchPage(page: number): Promise<KommoLeadsRead>;
  /**
   * Aplica las posiciones en la base; devuelve cuántos leads CAMBIARON. `readAtMs`
   * es cuándo se pidió la página: la base no pisa una posición fijada después.
   */
  apply(leads: KommoLeadPosition[], readAtMs: number): Promise<number>;
  /**
   * Recorrido completo: verifica POR ID en Kommo los leads que no aparecieron y
   * marca solo los confirmados ausentes (_shared/reconcile-leads.ts). Devuelve cuántos marcó.
   */
  finalize(): Promise<number>;
  /** Guarda el progreso como dueño del lease; lanza LeaseLostError si ya no lo es. */
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
      const { leads, hasMore, readAtMs } = await deps.fetchPage(nextPage);
      if (leads.length > 0) updated += await deps.apply(leads, readAtMs);
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
    if (e instanceof LeaseLostError) {
      // Otro worker es el dueño: su progreso manda. No se guarda nada (tampoco 'failed').
      return { status: "failed", nextPage, scanned, updated, error: e.message };
    }
    const failed: BackfillProgress = {
      status: "failed",
      nextPage,
      scanned,
      updated,
      error: e instanceof Error ? e.message : String(e),
    };
    await deps.save(failed).catch((se) => {
      if (se instanceof LeaseLostError) return; // ya no es el dueño: no hay nada que guardar
      console.error("backfill: no se pudo guardar el fallo:", se);
    });
    return failed;
  }
}
