// _shared/reconcile-leads.ts
// Reconcilia con Kommo una lista de leads POR ID. Lo usan dos caminos de
// sync-pipelines, y es lo que hace seguro el borrado de la marca «no existe en
// Kommo»:
//
//  - candidatos a inexistentes al cerrar un recorrido completo: el recorrido por
//    páginas (page=N) no es estable si se borra un lead mientras se lee, así que
//    «no apareció» solo es un candidato. Acá se pregunta a Kommo por esos ids
//    (filter[id][]): los que vuelven se APLICAN (estaban vivos, la página los
//    saltó); solo los que Kommo confirma ausentes se marcan.
//  - huecos: leads que nacieron sin pipeline. Se piden SOLO esos ids, sin
//    recorrer todo Kommo.
//
// Sin I/O propio (todo entra por `deps`): se testea sin red ni base.

import type { KommoLeadsRead } from "./kommo.ts";
import type { KommoLeadPosition } from "./kommo.ts";

export type ReconcileDeps = {
  /** Hasta `batchSize` ids; devuelve los que Kommo conoce. */
  fetchByIds(ids: number[]): Promise<KommoLeadsRead>;
  /** Aplica las posiciones (apply_kommo_lead_positions); devuelve cuántas filas cambió. */
  apply(leads: KommoLeadPosition[], readAtMs: number): Promise<number>;
  /** Marca los ids confirmados ausentes; devuelve cuántos marcó. */
  markMissing(ids: number[]): Promise<number>;
  sleep(ms: number): Promise<void>;
  /**
   * Latido tras cada lote: renueva el lease del recorrido que está finalizando. Con 5000
   * candidatos (50 lotes + segunda lectura) la reconciliación puede durar más que el lease
   * de 150 s; sin renovarlo, otro worker reclamaría el trabajo y correrían dos a la vez.
   */
  heartbeat?(): Promise<void>;
};

export type ReconcileResult = {
  checked: number;
  /** Existen en Kommo (se aplicó su posición). */
  found: number;
  /** Kommo confirmó que no existen y se marcaron. */
  marked: number;
  /**
   * Algún LOTE completo (de al menos SUSPICIOUS_MIN_IDS ids) volvió vacío: una respuesta
   * vacía de Kommo no es evidencia de que se borraron todos. Esos ids no se marcan.
   */
  suspicious: boolean;
};

/** Un lote de al menos esta cantidad de ids que vuelve vacío es una respuesta rara de Kommo. */
export const SUSPICIOUS_MIN_IDS = 20;

/**
 * Criterio por LOTE (no por el total): un lote pedido a Kommo que vuelve vacío siendo
 * grande es sospechoso aunque otros lotes hayan vuelto bien (un 200 vacío / respuesta
 * parcial en un lote no puede marcar 100 leads vivos como inexistentes).
 *
 * Y, con CUALQUIER cantidad, «no volvió» nunca se marca con una sola lectura: los ausentes
 * se vuelven a preguntar (segunda lectura, tras una pausa) y solo se marcan los que Kommo
 * vuelve a no devolver. Así también con 1-19 candidatos hay protección contra una respuesta
 * vacía puntual; y un lead que la segunda lectura sí devuelve se APLICA.
 */
export async function reconcileLeadIds(
  ids: number[],
  deps: ReconcileDeps,
  opts: { batchSize: number; pauseMs: number },
): Promise<ReconcileResult> {
  let found = 0;
  let suspicious = false;
  let absent: number[] = [];

  // Lee `list` por lotes; devuelve los ids que Kommo NO devolvió, ya sin los lotes sospechosos.
  async function readAll(list: number[], flagSuspicious: boolean): Promise<number[]> {
    const notReturned: number[] = [];
    for (let i = 0; i < list.length; i += opts.batchSize) {
      const batch = list.slice(i, i + opts.batchSize);
      const read = await deps.fetchByIds(batch);
      if (read.leads.length > 0) await deps.apply(read.leads, read.readAtMs);
      const seen = new Set(read.leads.map((l) => l.id));
      found += seen.size;
      const gone = batch.filter((id) => !seen.has(id));
      if (flagSuspicious && seen.size === 0 && batch.length >= SUSPICIOUS_MIN_IDS) {
        suspicious = true; // lote entero vacío: no es evidencia, no se marca nada de él
      } else {
        notReturned.push(...gone);
      }
      await deps.heartbeat?.();
      if (i + opts.batchSize < list.length) await deps.sleep(opts.pauseMs);
    }
    return notReturned;
  }

  absent = await readAll(ids, true);
  if (absent.length > 0) {
    // Segunda lectura de los ausentes: solo se marcan los confirmados dos veces.
    await deps.sleep(opts.pauseMs);
    const confirmedGone = await readAll(absent, false);
    absent = confirmedGone;
  }
  const marked = absent.length > 0 ? await deps.markMissing(absent) : 0;
  return { checked: ids.length, found, marked, suspicious };
}
