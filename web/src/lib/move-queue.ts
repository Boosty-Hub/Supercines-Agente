// Cola de movimientos de etapa POR LEAD (pura: sin React, sin fetch, sin imports).
//
// Problema: dos clics/arrastres rápidos sobre la misma tarjeta lanzaban dos PATCH a
// Kommo en paralelo y podían llegar en orden inverso, dejando el lead en la etapa
// VIEJA aunque el tablero mostrara la nueva.
//
// Criterio (gana el ÚLTIMO destino elegido):
//  - Por lead hay a lo sumo UN envío en vuelo. Los movimientos que llegan mientras
//    tanto se COALESCEN en uno solo: el más reciente reemplaza al pendiente (el
//    reemplazado se resuelve como "superseded"; nunca llega a Kommo, así que no hay
//    pasos intermedios inútiles ni orden invertido posible).
//  - La cola conoce la posición CONFIRMADA (la última que el servidor aceptó) y la
//    manda como `expected` en cada envío; el servidor responde 409 si la posición real
//    es otra (alguien movió el lead en Kommo, o la lista estaba vieja). Ante un 409 se
//    adopta la posición real y se REENCOLA una vez; si vuelve a chocar, se rinde con
//    error para no pelear con otro operador en bucle.
//  - Estado optimista consistente: el que llama pinta el destino al encolar. Si un
//    envío falla, `revertTo` dice a qué posición volver, o es null si hay un
//    movimiento más nuevo pendiente (el tablero ya muestra ESE destino y no debe
//    saltar hacia atrás).
//  - «Ocupado» (409 move_in_progress): otro movimiento del MISMO lead está en vuelo desde
//    otra pestaña u otra persona (la reserva vive en la base: claim_lead_move). No es un
//    error de este movimiento: se reintenta tras esperas cortas (BUSY_RETRY_DELAYS_MS) y,
//    si sigue ocupado, se resuelve como `deferred` — un aviso NEUTRO y releer la posición
//    real. NUNCA se revierte la tarjeta con un error: la posición a la que volver no se
//    conoce (el otro movimiento la está cambiando) y revertir a la vieja sería mentir.

export type Position = { pipeline: number | null; stage: number | null };
export type Dest = { pipeline: number; stage: number };

export type SendResult =
  | { kind: "ok"; warning?: string }
  | { kind: "conflict"; current: Position }
  /** Otro movimiento del mismo lead está en vuelo (409 move_in_progress). */
  | { kind: "busy" }
  | { kind: "error"; message: string };

/**
 * Traduce la respuesta de POST /api/leads/[id]/stage a un SendResult:
 *  - 409 position_changed → conflict con la posición vigente (la cola la adopta y reencola);
 *  - 409 move_in_progress → busy: otro movimiento del lead en vuelo (otra pestaña/persona);
 *    la cola reintenta y, si sigue, avisa en neutro. NO es un error de este movimiento;
 *  - otro no-2xx → error con el mensaje del servidor.
 */
export function interpretMoveResponse(status: number, json: unknown): SendResult {
  const body = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  if (status === 409 && body.code === "position_changed") {
    const c = (body.current && typeof body.current === "object" ? body.current : {}) as Record<string, unknown>;
    return {
      kind: "conflict",
      current: {
        pipeline: typeof c.pipeline_id === "number" ? c.pipeline_id : null,
        stage: typeof c.stage_id === "number" ? c.stage_id : null,
      },
    };
  }
  if (status === 409 && body.code === "move_in_progress") return { kind: "busy" };
  if (status < 200 || status >= 300) {
    return { kind: "error", message: typeof body.error === "string" ? body.error : `HTTP ${status}` };
  }
  return { kind: "ok", warning: typeof body.warning === "string" ? body.warning : undefined };
}

/** Envía UN movimiento. No debe lanzar (si lo hace se trata como error). */
export type Send = (leadId: string, dest: Dest, expected: Position) => Promise<SendResult>;

export type MoveOutcome =
  /** Kommo/servidor aceptó el movimiento (puede traer un aviso: movido pero sin registrar). */
  | { kind: "done"; warning?: string }
  /** Reemplazado por un movimiento más nuevo del mismo lead: no se envió. */
  | { kind: "superseded" }
  /** El lead ya estaba en el destino: no hubo nada que enviar. */
  | { kind: "noop" }
  /** Falló. `revertTo` = posición a restaurar, o null si hay un movimiento más nuevo pendiente. */
  | { kind: "failed"; message: string; revertTo: Position | null }
  /**
   * No se envió porque otro movimiento del lead (otra pestaña/persona) siguió en vuelo tras
   * los reintentos. Aviso NEUTRO: el llamador relee la posición real, no revierte a ciegas.
   */
  | { kind: "deferred"; message: string };

/** Esperas antes de reintentar un envío «ocupado» (2 reintentos, backoff creciente). */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = [700, 1_500];

export const DEFERRED_MESSAGE =
  "Otro movimiento de este lead está en curso (otra pestaña u otra persona). Se muestra su posición real; si no quedó donde querías, volvé a moverlo.";

export type MoveQueueOptions = {
  /** Espera inyectable (tests). */
  sleep?: (ms: number) => Promise<void>;
  busyRetryDelaysMs?: readonly number[];
};

type Job = { dest: Dest; resolve: (o: MoveOutcome) => void };
type LeadState = { confirmed: Position; running: boolean; wanted: Job | null };

const same = (a: Position, b: Dest) => a.pipeline === b.pipeline && a.stage === b.stage;

export class MoveQueue {
  private readonly states = new Map<string, LeadState>();
  private readonly send: Send;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly busyDelays: readonly number[];

  // Sin "parameter properties": node --test solo quita tipos, no transforma.
  constructor(send: Send, opts: MoveQueueOptions = {}) {
    this.send = send;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.busyDelays = opts.busyRetryDelaysMs ?? BUSY_RETRY_DELAYS_MS;
  }

  /** ¿Hay un envío en vuelo o un movimiento esperando para este lead? */
  isBusy(leadId: string): boolean {
    const s = this.states.get(leadId);
    return !!s && (s.running || s.wanted !== null);
  }

  /**
   * Encola el movimiento de `leadId` a `dest`. `current` es la posición que el
   * llamador conoce ANTES de mover; solo se usa si el lead no tiene un movimiento en
   * curso (si lo tiene, manda la posición confirmada de la cola).
   */
  enqueue(leadId: string, dest: Dest, current: Position): Promise<MoveOutcome> {
    let state = this.states.get(leadId);
    if (!state) {
      state = { confirmed: current, running: false, wanted: null };
      this.states.set(leadId, state);
    }
    state.wanted?.resolve({ kind: "superseded" });
    const st = state;
    return new Promise<MoveOutcome>((resolve) => {
      st.wanted = { dest, resolve };
      if (!st.running) void this.drain(leadId, st);
    });
  }

  private async drain(leadId: string, st: LeadState): Promise<void> {
    st.running = true;
    try {
      while (st.wanted) {
        const job = st.wanted;
        st.wanted = null;
        job.resolve(await this.runJob(leadId, st, job));
      }
    } finally {
      st.running = false;
      if (!st.wanted) this.states.delete(leadId);
    }
  }

  private async attempt(leadId: string, st: LeadState, dest: Dest): Promise<SendResult> {
    try {
      return await this.send(leadId, dest, st.confirmed);
    } catch (e) {
      return { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  private async runJob(leadId: string, st: LeadState, job: Job): Promise<MoveOutcome> {
    // Volvió al origen antes de que saliera el envío anterior: no hay nada que mandar.
    if (same(st.confirmed, job.dest)) return { kind: "noop" };

    let conflictRetries = 1; // un 409 de posición se reencola UNA vez
    let busyAttempt = 0;
    for (;;) {
      const res = await this.attempt(leadId, st, job.dest);

      if (res.kind === "ok") {
        st.confirmed = { pipeline: job.dest.pipeline, stage: job.dest.stage };
        return { kind: "done", warning: res.warning };
      }
      if (res.kind === "error") {
        return { kind: "failed", message: res.message, revertTo: st.wanted ? null : st.confirmed };
      }
      if (res.kind === "conflict") {
        st.confirmed = res.current;
        // Hay un movimiento más nuevo esperando: ese saldrá con la posición ya corregida.
        if (st.wanted) return { kind: "superseded" };
        if (same(st.confirmed, job.dest)) return { kind: "noop" };
        if (conflictRetries > 0) {
          conflictRetries--;
          continue;
        }
        return {
          kind: "failed",
          message: "El lead cambió de etapa mientras tanto (alguien lo movió en Kommo). Revisá su posición y volvé a intentar.",
          revertTo: st.confirmed,
        };
      }
      // busy: otro movimiento del mismo lead en vuelo (otra pestaña/persona).
      if (st.wanted) return { kind: "superseded" };
      if (busyAttempt >= this.busyDelays.length) return { kind: "deferred", message: DEFERRED_MESSAGE };
      await this.sleep(this.busyDelays[busyAttempt++]);
      // Mientras se esperaba llegó un destino más nuevo: ese sale (con la misma cola).
      if (st.wanted) return { kind: "superseded" };
    }
  }
}
