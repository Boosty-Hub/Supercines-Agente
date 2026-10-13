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

export type Position = { pipeline: number | null; stage: number | null };
export type Dest = { pipeline: number; stage: number };

export type SendResult =
  | { kind: "ok"; warning?: string }
  | { kind: "conflict"; current: Position }
  | { kind: "error"; message: string };

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
  | { kind: "failed"; message: string; revertTo: Position | null };

type Job = { dest: Dest; resolve: (o: MoveOutcome) => void };
type LeadState = { confirmed: Position; running: boolean; wanted: Job | null };

const same = (a: Position, b: Dest) => a.pipeline === b.pipeline && a.stage === b.stage;

export class MoveQueue {
  private readonly states = new Map<string, LeadState>();
  private readonly send: Send;

  // Sin "parameter properties": node --test solo quita tipos, no transforma.
  constructor(send: Send) {
    this.send = send;
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

    let res = await this.attempt(leadId, st, job.dest);

    if (res.kind === "conflict") {
      st.confirmed = res.current;
      // Hay un movimiento más nuevo esperando: ese saldrá con la posición ya corregida.
      if (st.wanted) return { kind: "superseded" };
      if (same(st.confirmed, job.dest)) return { kind: "noop" };
      res = await this.attempt(leadId, st, job.dest); // reencolar UNA vez
      if (res.kind === "conflict") {
        st.confirmed = res.current;
        if (st.wanted) return { kind: "superseded" };
        return {
          kind: "failed",
          message: "El lead cambió de etapa mientras tanto (alguien lo movió en Kommo). Revisá su posición y volvé a intentar.",
          revertTo: st.confirmed,
        };
      }
    }

    if (res.kind === "ok") {
      st.confirmed = { pipeline: job.dest.pipeline, stage: job.dest.stage };
      return { kind: "done", warning: res.warning };
    }
    if (res.kind === "error") {
      return { kind: "failed", message: res.message, revertTo: st.wanted ? null : st.confirmed };
    }
    // conflict ya tratado arriba; defensa para el tipado.
    return { kind: "failed", message: "Respuesta inesperada del servidor.", revertTo: st.wanted ? null : st.confirmed };
  }
}
