// _shared/followup-claim.ts
// Parte pura (sin I/O) del envío de seguimientos con reserva por lead y paso
// (migración 0072). La atomicidad la garantiza la base (claim_follow_up,
// mark_follow_up_sending, finish_follow_up, release_follow_up_claim,
// recover_dead_follow_up_claims — ver supabase/tests/follow_up_claim.sql); acá viven
// las decisiones que toma follow-up-scan con lo que la base le devuelve, para
// probarlas sin red ni base. Mismo modelo que _shared/draft-publish.ts (0071).
//
// GARANTÍA DE ENVÍO (lo que el cliente final ve):
//   · A lo sumo UN envío por (lead, paso): solo el dueño de la reserva envía, y antes
//     del salesbot fija la marca write-ahead `sending_at` (si el lease venció, la
//     marca falla y NO se dispara nada). El paso enviado queda registrado con índice
//     único y el lead avanza en la misma transacción.
//   · Con la marca puesta, un corte NUNCA termina en reenvío automático: o se confirma
//     en Kommo que salió (`sent`), o queda «sin confirmar» (`failed` con sending_at) +
//     alerta, y solo una persona puede reenviarlo desde el panel, confirmándolo.
//   · Muerte ANTES de la marca: no salió nada (escribir los campos de Kommo no le manda
//     nada al cliente) → se reintenta, hasta el tope de interrupciones de la base.

import { resolveInterrupted } from "./draft-publish.ts";
import type { OutgoingEvent } from "./kommo.ts";

/** Lease de la reserva. Mayor que el wall clock máximo de una Edge Function (400 s):
 *  cuando vence, el worker está muerto con certeza. */
export const FOLLOW_UP_LEASE_SECONDS = 600;

/** Motivos con los que claim_follow_up se niega a reservar (ver 0072). */
export type ClaimRefusal =
  | "lead_not_found"
  | "opted_out"
  | "terminal"
  | "step_changed"
  | "superseded"
  | "in_flight"
  | "already_sent"
  | "unconfirmed"
  | "interrupted_cap";

/** Texto para el operador (lo muestra el botón «Reintentar» del panel). */
export const CLAIM_MESSAGES: Record<ClaimRefusal, string> = {
  lead_not_found: "el lead no existe",
  opted_out: "el lead pidió no recibir más mensajes (opt-out)",
  terminal: "el seguimiento de este lead ya terminó (respondió, se detuvo o llegó al máximo)",
  step_changed: "ese paso ya se procesó: el lead avanzó mientras tanto",
  superseded:
    "ese intento ya no es el último de este paso: hubo un intento posterior. Recargá la página y, si hace falta, reintentá desde el más reciente",
  in_flight: "ya hay un seguimiento en curso para este lead; esperá a que termine",
  already_sent: "ese paso del seguimiento ya se le envió a este lead",
  unconfirmed:
    "el intento anterior de este paso pudo haberle llegado y no se pudo confirmar; revisá la conversación en Kommo antes de reenviarlo",
  interrupted_cap:
    "este paso se interrumpió varias veces antes de enviarse; el barrido automático no lo reintenta más (reintentalo a mano)",
};

export type ClaimResult =
  | { ok: true; id: string }
  | { ok: false; reason: ClaimRefusal | "error"; message: string };

/** Interpreta la respuesta de `supabase.rpc("claim_follow_up", …)` (una fila: follow_up_id, reason). */
export function interpretClaim(data: unknown, error: { message: string } | null): ClaimResult {
  if (error) return { ok: false, reason: "error", message: `claim_follow_up: ${error.message}` };
  const row = (Array.isArray(data) ? data[0] : data) as { follow_up_id?: unknown; reason?: unknown } | null | undefined;
  const reason = typeof row?.reason === "string" ? row.reason : null;
  if (reason === "claimed" && typeof row?.follow_up_id === "string" && row.follow_up_id) {
    return { ok: true, id: row.follow_up_id };
  }
  // Object.hasOwn: el motivo viene de afuera (la base); "constructor", "toString" o
  // "__proto__" no pueden resolver a algo heredado de Object.prototype.
  if (reason && Object.hasOwn(CLAIM_MESSAGES, reason)) {
    const r = reason as ClaimRefusal;
    return { ok: false, reason: r, message: CLAIM_MESSAGES[r] };
  }
  return { ok: false, reason: "error", message: `claim_follow_up: respuesta inesperada (${JSON.stringify(data)})` };
}

// ---------------------------------------------------------------------------
// Resultado de un paso reservado → cómo se cierra la reserva.
// ---------------------------------------------------------------------------

export type FollowUpOutcome =
  /** Salió (confirmado por el flujo normal, o recuperado al ver el saliente en Kommo). */
  | { kind: "sent"; variables?: Record<string, string>; recovered?: boolean }
  /** No salió nada (falló antes de la marca de envío). El barrido lo reintenta. */
  | { kind: "failed"; error: string; variables?: Record<string, string> }
  /** Pudo haber salido (después de la marca) y no se confirmó: nunca se reenvía solo. */
  | { kind: "unconfirmed"; error: string; variables?: Record<string, string> }
  /** No hubo intento de envío (el agente decidió no escribir, el lead ya no aplica). */
  | { kind: "released"; reason: string }
  /** La reserva ya no es nuestra (lease vencido al marcar): no se envió ni se toca nada. */
  | { kind: "lease_lost" };

export type ClaimClose =
  | {
      rpc: "finish_follow_up";
      status: "sent" | "failed";
      error: string | null;
      variables: Record<string, string> | null;
    }
  | { rpc: "release_follow_up_claim" }
  | null;

/** Cómo cerrar la reserva según el resultado. null = no tocar (ya no es nuestra). */
export function closeFor(outcome: FollowUpOutcome): ClaimClose {
  switch (outcome.kind) {
    case "sent":
      return {
        rpc: "finish_follow_up",
        status: "sent",
        error: outcome.recovered ? "el envío se interrumpió, pero se confirmó en Kommo que salió" : null,
        variables: outcome.variables ?? null,
      };
    case "failed":
    case "unconfirmed":
      // «Sin confirmar» se distingue en la base por sending_at (la marca ya está puesta).
      return { rpc: "finish_follow_up", status: "failed", error: outcome.error, variables: outcome.variables ?? null };
    case "released":
      return { rpc: "release_follow_up_claim" };
    case "lease_lost":
      return null;
  }
}

const UNCONFIRMED_PREFIX = "sin confirmar:";

/** Resultado de una excepción durante el trabajo con la reserva tomada. */
export function outcomeAfterError(message: string, marked: boolean): FollowUpOutcome {
  if (marked) {
    return {
      kind: "unconfirmed",
      error:
        `${UNCONFIRMED_PREFIX} el envío se cortó después de disparar la plantilla (${message}); ` +
        "no se reenvía: revisá en Kommo si le llegó",
    };
  }
  return { kind: "failed", error: message };
}

/**
 * Resuelve una reserva muerta CON marca de envío (recover_dead_follow_up_claims →
 * resolve). NUNCA devuelve «reenviar»: con la marca la plantilla pudo haber salido.
 * Solo es «enviado» si aparece un saliente DE ESE LEAD que no estaba en la foto previa
 * y es posterior a `sendingAt`; sin foto (Kommo no se pudo leer al enviar) o sin poder
 * leer Kommo ahora, queda «sin confirmar» (ver resolveInterrupted).
 */
export function resolveDeadFollowUp(
  baseline: readonly string[] | null,
  current: readonly OutgoingEvent[] | null,
  sendingAt: string | null
): Extract<FollowUpOutcome, { kind: "sent" } | { kind: "unconfirmed" }> {
  const d = resolveInterrupted(baseline, current, sendingAt);
  if (d.action === "mark_sent") return { kind: "sent", recovered: true };
  return {
    kind: "unconfirmed",
    error:
      `${UNCONFIRMED_PREFIX} el seguimiento se interrumpió después de disparar la plantilla y no se encontró el mensaje saliente; ` +
      "no se reenvía: revisá en Kommo y, si no le llegó, reintentalo a mano",
  };
}

// ---------------------------------------------------------------------------
// Orquestación de un paso: reservar → trabajar → cerrar. Nunca envía sin reserva.
// ---------------------------------------------------------------------------

/** La marca de envío falló: la reserva ya no es de este worker → NO se dispara nada. */
export class FollowUpLeaseLostError extends Error {
  constructor(public followUpId: string) {
    super(`la reserva del seguimiento ${followUpId} ya no es de este worker; no se envía`);
    this.name = "FollowUpLeaseLostError";
  }
}

export type LeadRunResult = { kind: "refused"; reason: ClaimRefusal | "error"; message: string } | FollowUpOutcome;

export type SendingMark = (baseline: string[] | null, variables: Record<string, string>) => Promise<void>;

export async function runClaimedFollowUp(deps: {
  /** claim_follow_up ya interpretado. */
  claim: () => Promise<ClaimResult>;
  /** mark_follow_up_sending: true si la marca quedó puesta (dueño + lease vigente). */
  mark: (id: string, baseline: string[] | null, variables: Record<string, string>) => Promise<boolean>;
  /** El trabajo con la reserva tomada. Debe llamar a `markSending` justo antes del salesbot. */
  work: (markSending: SendingMark) => Promise<FollowUpOutcome>;
  /** Aplica el cierre (finish_follow_up / release_follow_up_claim) con la guarda de dueño. */
  close: (id: string, close: Exclude<ClaimClose, null>) => Promise<void>;
}): Promise<LeadRunResult> {
  const claim = await deps.claim();
  if (!claim.ok) return { kind: "refused", reason: claim.reason, message: claim.message };

  let marked = false;
  const markSending: SendingMark = async (baseline, variables) => {
    if (!(await deps.mark(claim.id, baseline, variables))) throw new FollowUpLeaseLostError(claim.id);
    marked = true;
  };

  let outcome: FollowUpOutcome;
  try {
    outcome = await deps.work(markSending);
  } catch (err) {
    if (err instanceof FollowUpLeaseLostError) return { kind: "lease_lost" };
    outcome = outcomeAfterError(err instanceof Error ? err.message : String(err), marked);
  }
  // Invariante: con la marca puesta, nada se cierra como «no salió». Un fallo o una
  // liberación después de marcar pasa a «sin confirmar» (nunca habilita un reenvío).
  if (marked && (outcome.kind === "failed" || outcome.kind === "released")) {
    outcome = outcomeAfterError(outcome.kind === "failed" ? outcome.error : outcome.reason, true);
  }

  const close = closeFor(outcome);
  if (close) {
    try {
      await deps.close(claim.id, close);
    } catch (err) {
      // El lease vence y la recuperación lo resuelve (sin marca: reintento; con marca: verificación).
      console.error(
        `follow-up: no se pudo cerrar la reserva ${claim.id} (${outcome.kind}):`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return outcome;
}
