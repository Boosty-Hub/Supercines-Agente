// _shared/reconcile-leads.ts
// Reconcilia con Kommo una lista de leads POR ID. Lo usan tres caminos de
// sync-pipelines, y es lo que hace seguro el borrado de la marca «no existe en
// Kommo»:
//
//  - candidatos a inexistentes al cerrar un recorrido completo: el recorrido por
//    páginas (page=N) no es estable si se borra un lead mientras se lee, así que
//    «no apareció» solo es un candidato. Acá se pregunta a Kommo por esos ids
//    (filter[id][]): los que vuelven se APLICAN (estaban vivos, la página los
//    saltó); solo los que Kommo confirma ausentes se marcan.
//  - candidatos que quedaron pendientes con el recorrido ya terminado ('done'):
//    se siguen verificando por tandas, sin reiniciar el recorrido.
//  - huecos: leads que nacieron sin pipeline. Se piden SOLO esos ids, sin
//    recorrer todo Kommo.
//
// Cómo se confirma que un lead NO existe (nunca por ausencia en una sola lectura):
//  1. Primera lectura en lotes de `batchSize`: lo que vuelve se aplica; lo que no
//     vuelve es solo «ausente».
//  2. Confirmación de los ausentes en lotes más chicos (`confirmBatchSize`), y en
//     CADA lote se agrega un CONTROL POSITIVO: un lead que sí existe en Kommo. Si el
//     control vuelve, Kommo procesó el filtro y el vacío del resto es real → se marcan
//     los que tampoco volvieron esta vez. Si el control no vuelve, la respuesta es
//     sospechosa (vacía por error, recortada, rara) y ese lote NO se marca: queda
//     candidato para la próxima pasada.
//  Antes, un LOTE entero que volvía vacío se declaraba sospechoso sin más, y con
//  leads viejos borrados en masa todos los lotes vuelven vacíos: nunca se marcaba
//  nada (KIA, oct-2026: 17.199 leads borrados quedaron como «Sin pipeline»).
//
// Un error de Kommo (HTTP, 429 agotado, cuerpo mal formado) corta la pasada sin
// marcar el lote en curso; lo ya confirmado con control queda marcado.
//
// Sin I/O propio (todo entra por `deps`): se testea sin red ni base.

import type { KommoLeadsRead } from "./kommo.ts";
import type { KommoLeadPosition } from "./kommo.ts";

export type ReconcileDeps = {
  /** Hasta `batchSize` ids; devuelve los que Kommo conoce. Lanza ante error / 429 agotado / cuerpo raro. */
  fetchByIds(ids: number[]): Promise<KommoLeadsRead>;
  /** Aplica las posiciones (apply_kommo_lead_positions); devuelve cuántas filas cambió. */
  apply(leads: KommoLeadPosition[], readAtMs: number): Promise<number>;
  /** Marca los ids confirmados ausentes; devuelve cuántos marcó. */
  markMissing(ids: number[]): Promise<number>;
  /**
   * Ids de leads que PROBABLEMENTE existen en Kommo (vistos hace poco), para usar como
   * control positivo cuando la primera lectura no devolvió ninguno vivo. No hace falta
   * que sean seguros: un control que no vuelve solo deja su lote sin marcar.
   */
  controlCandidates?(): Promise<number[]>;
  sleep(ms: number): Promise<void>;
  /**
   * Latido tras cada lote: renueva el lease del recorrido que está finalizando. Con 5000
   * candidatos la reconciliación puede durar más que el lease de 150 s; sin renovarlo,
   * otro worker reclamaría el trabajo y correrían dos a la vez.
   */
  heartbeat?(): Promise<void>;
  /** Reloj (ms) para `deadlineMs`. Default Date.now. */
  now?(): number;
};

export type ReconcileOptions = {
  /** Ids por pedido en la primera lectura (≤ KOMMO_IDS_PER_REQUEST). */
  batchSize: number;
  /** Pausa entre pedidos (rate limit compartido de Kommo, ~4 req/s). */
  pauseMs: number;
  /** Ids por pedido en la confirmación, CONTANDO el control. Default min(batchSize, 25). */
  confirmBatchSize?: number;
  /**
   * Instante (ms, mismo reloj que deps.now) desde el que no se empieza ningún pedido nuevo.
   * Lo que no se llegó a confirmar no se marca y queda candidato para la próxima pasada.
   */
  deadlineMs?: number;
};

export type ReconcileResult = {
  checked: number;
  /** Existen en Kommo (se aplicó su posición). */
  found: number;
  /** Kommo confirmó (con control positivo) que no existen y se marcaron. */
  marked: number;
  /**
   * Algún lote de confirmación no trajo el control positivo (o no hubo control): esa
   * respuesta no es evidencia y sus ids no se marcaron.
   */
  suspicious: boolean;
  /** Ausentes que quedaron sin confirmar (sospechosos o sin tiempo): siguen candidatos. */
  unconfirmed: number;
};

/** Controles que pueden fallar seguidos antes de abandonar la confirmación (Kommo raro: no gastar cuota). */
export const MAX_CONTROL_FAILURES = 3;

export async function reconcileLeadIds(
  ids: number[],
  deps: ReconcileDeps,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const now = deps.now ?? Date.now;
  const confirmSize = Math.max(2, opts.confirmBatchSize ?? Math.min(opts.batchSize, 25));
  const outOfTime = () => opts.deadlineMs !== undefined && now() >= opts.deadlineMs;
  const unique = [...new Set(ids)];
  const asked = new Set(unique);

  let found = 0;
  let marked = 0;
  let suspicious = false;
  let requests = 0;
  /** Vistos vivos en esta pasada (los mejores controles: Kommo los acaba de devolver). */
  const alive: number[] = [];

  const pause = async () => {
    if (requests > 0) await deps.sleep(opts.pauseMs);
  };
  /**
   * Un pedido a Kommo: aplica lo que vuelve y devuelve los ids devueltos. `complete` = false si
   * Kommo indica otra página (`hasMore`): con ≤ 100 ids no debería pasar nunca, y si pasa la
   * ausencia de un id no prueba nada (podría estar en la página siguiente).
   */
  const read = async (batch: number[]): Promise<{ returned: Set<number>; complete: boolean }> => {
    await pause();
    requests++;
    const r = await deps.fetchByIds(batch);
    if (r.leads.length > 0) await deps.apply(r.leads, r.readAtMs);
    return { returned: new Set(r.ids ?? r.leads.map((l) => l.id)), complete: !r.hasMore };
  };

  // 1. Primera lectura.
  const absent: number[] = [];
  let firstPassDone = 0;
  for (let i = 0; i < unique.length; i += opts.batchSize) {
    if (outOfTime()) break;
    const batch = unique.slice(i, i + opts.batchSize);
    const { returned } = await read(batch);
    for (const id of batch) {
      if (returned.has(id)) {
        found++;
        alive.push(id);
      } else {
        absent.push(id);
      }
    }
    firstPassDone += batch.length;
    await deps.heartbeat?.();
  }

  // 2. Confirmación con control positivo.
  let controls: number[] = [...alive];
  let externalLoaded = false;
  const nextControl = async (): Promise<number | undefined> => {
    if (controls.length === 0 && !externalLoaded && deps.controlCandidates) {
      externalLoaded = true;
      controls = (await deps.controlCandidates()).filter((id) => !asked.has(id));
    }
    return controls[0];
  };

  const perChunk = confirmSize - 1;
  let confirmed = 0;
  let controlFailures = 0;
  for (let i = 0; i < absent.length; i += perChunk) {
    if (outOfTime()) break;
    const control = await nextControl();
    if (control === undefined) {
      suspicious = true; // sin control no hay evidencia: nada de lo que queda se marca
      break;
    }
    const chunk = absent.slice(i, i + perChunk);
    const { returned, complete } = await read([...chunk, control]);
    const back = chunk.filter((id) => returned.has(id));
    found += back.length;
    if (!complete) {
      // Respuesta paginada: el control no prueba que estén todos. No se marca nada de este lote.
      suspicious = true;
      confirmed += back.length;
      await deps.heartbeat?.();
      continue;
    }
    if (!returned.has(control)) {
      // Respuesta sospechosa (o el control se borró): este lote no se marca.
      // Los que sí volvieron quedan resueltos (vivos, aplicados).
      suspicious = true;
      confirmed += back.length;
      controls.shift();
      controlFailures++;
      await deps.heartbeat?.();
      if (controlFailures >= MAX_CONTROL_FAILURES) break;
      continue;
    }
    controlFailures = 0;
    const gone = chunk.filter((id) => !returned.has(id));
    if (gone.length > 0) marked += await deps.markMissing(gone);
    confirmed += chunk.length;
    await deps.heartbeat?.();
  }

  const unconfirmed = (unique.length - firstPassDone) + (absent.length - confirmed);
  return { checked: unique.length, found, marked, suspicious, unconfirmed };
}
