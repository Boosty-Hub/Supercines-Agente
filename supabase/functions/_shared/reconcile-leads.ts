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
};

export type ReconcileResult = {
  checked: number;
  /** Existen en Kommo (se aplicó su posición). */
  found: number;
  /** Kommo confirmó que no existen y se marcaron. */
  marked: number;
  /**
   * Ninguno de los ids volvió en NINGÚN lote (y eran varios): una respuesta vacía
   * de Kommo no es evidencia de que se borraron todos. No se marca nada.
   */
  suspicious: boolean;
};

/** Con menos candidatos que esto, «ninguno volvió» sí es plausible (se borraron). */
export const SUSPICIOUS_MIN_IDS = 20;

export async function reconcileLeadIds(
  ids: number[],
  deps: ReconcileDeps,
  opts: { batchSize: number; pauseMs: number },
): Promise<ReconcileResult> {
  const missing: number[] = [];
  let found = 0;

  for (let i = 0; i < ids.length; i += opts.batchSize) {
    const batch = ids.slice(i, i + opts.batchSize);
    const read = await deps.fetchByIds(batch);
    if (read.leads.length > 0) await deps.apply(read.leads, read.readAtMs);
    const seen = new Set(read.leads.map((l) => l.id));
    found += seen.size;
    for (const id of batch) if (!seen.has(id)) missing.push(id);
    if (i + opts.batchSize < ids.length) await deps.sleep(opts.pauseMs);
  }

  const suspicious = found === 0 && ids.length >= SUSPICIOUS_MIN_IDS;
  const marked = missing.length > 0 && !suspicious ? await deps.markMissing(missing) : 0;
  return { checked: ids.length, found, marked, suspicious };
}
