// _shared/followup-retry.ts
//
// Lógica PURA del reintento MANUAL de un seguimiento (botón "Reintentar" en
// /seguimiento, sobre un intento de `follow_ups` que quedó en `failed`). Separada de
// follow-up-scan/index.ts para poder probar la decisión sin levantar
// Supabase ni Kommo: acá se decide SI se puede reintentar y CON QUÉ MOTIVO —
// nunca se llama a nada por red.
//
// El reintento es POR INTENTO: el panel manda el intento (`follow_up_id`) y su paso.
// Solo se reintenta si ese paso es el que el lead debe recibir AHORA
// (follow_up_step + 1) y si ese intento es el ÚLTIMO de ese paso para ese lead; si no,
// es un conflicto (409): la persona está mirando una fila vieja. Lo de «último» lo
// decide la base de forma atómica (claim_follow_up con p_attempt_id, 0077 → `superseded`);
// acá se valida el pedido contra la fila y el lead antes de tomar la reserva.
//
// El reintento es una decisión humana explícita (mismo criterio que el envío
// manual de publish-to-kommo), así que el llamador (`retryOne` en index.ts)
// saltea la rotación del barrido automático y el reloj `min_gap_hours`. Lo
// que este módulo SÍ hace cumplir son los gates que protegen al cliente:
// opt-out, estados terminales del seguimiento, falta de `kommo_lead_id`, el
// seguimiento apagado en la config, y el tope de `max_follow_ups`. El horario
// laboral NO vive acá — lo evalúa el llamador con `isBusinessHours` de
// `business-hours.ts`, que ya es pura y ya tiene su propio contrato.
//
// Que el reintento manual y el barrido no le manden DOS veces el mismo paso al lead
// no se decide acá: lo garantiza la reserva por lead y paso (0072, _shared/followup-claim.ts),
// que ambos caminos toman antes de enviar.

import type { LeadRunResult } from "./followup-claim.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pedido de follow-up-scan: barrido automático (sin intento) o reintento de UN intento. */
export type ScanRequest =
  | { kind: "sweep" }
  | { kind: "retry"; followUpId: string; step: number; force: boolean; confirmResend: boolean }
  | { kind: "invalid"; error: string };

/**
 * Interpreta el body de follow-up-scan. Sin `follow_up_id` = barrido automático (el
 * cron no manda body). Con `follow_up_id` exige también `step` (el paso de la fila que
 * la persona eligió): sin él no se puede saber si el lead avanzó.
 */
export function parseScanRequest(body: unknown): ScanRequest {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return { kind: "sweep" };
  const b = body as Record<string, unknown>;
  const id = Object.hasOwn(b, "follow_up_id") ? b.follow_up_id : undefined;
  if (id === undefined || id === null) return { kind: "sweep" };
  if (typeof id !== "string" || !UUID_RE.test(id.trim())) {
    return { kind: "invalid", error: "follow_up_id inválido" };
  }
  const step = Object.hasOwn(b, "step") ? b.step : undefined;
  if (typeof step !== "number" || !Number.isInteger(step) || step < 1) {
    return { kind: "invalid", error: "step inválido (entero ≥ 1, el paso del intento)" };
  }
  return {
    kind: "retry",
    followUpId: id.trim().toLowerCase(),
    step,
    force: Object.hasOwn(b, "force") && b.force === true,
    confirmResend: Object.hasOwn(b, "confirm_resend") && b.confirm_resend === true,
  };
}

/** La fila del intento que la persona eligió (follow_ups). */
export type RetryAttemptRow = {
  id: string;
  lead_id: string;
  step: number;
  status: string;
};

export type RetryLeadRow = {
  follow_up_step: number | null;
  follow_up_status: string | null;
  opted_out: boolean | null;
  kommo_lead_id: number | null;
};

export type RetryConfigRow = {
  enabled: boolean | null;
  max_follow_ups: number | null;
};

export type RetryGateOk = {
  ok: true;
  /** Paso a reintentar: follow_up_step + 1 (el que le toca al lead), = el del intento. */
  step: number;
  maxFollowUps: number;
};

export type RetryGateBlocked = {
  ok: false;
  /** Motivo LEGIBLE para el operador — nunca un silencio. */
  reason: string;
  /** El pedido no corresponde al estado actual (fila vieja, paso ya avanzado): 409. */
  conflict?: true;
};

export type RetryGateResult = RetryGateOk | RetryGateBlocked;

const TERMINAL_FOLLOW_UP_STATUSES = new Set(["responded", "stopped", "exhausted"]);

/**
 * Decide si el intento pedido puede reintentarse AHORA MISMO — sin mirar todavía
 * horario laboral (eso es del llamador) ni si el paso tiene una plantilla habilitada
 * en `follow_up_steps` (eso exige una consulta aparte).
 *
 * @param requestedStep el paso que mandó el panel (el de la fila elegida).
 * @param attempt       la fila de ese intento (null si no existe).
 * @param lead          el lead DEL INTENTO.
 */
export function evaluateRetryGate(
  requestedStep: number,
  attempt: RetryAttemptRow | null | undefined,
  lead: RetryLeadRow | null | undefined,
  cfg: RetryConfigRow | null | undefined
): RetryGateResult {
  if (!attempt) {
    return { ok: false, conflict: true, reason: "ese intento de seguimiento ya no existe; recargá la página" };
  }
  if (Number(attempt.step) !== requestedStep) {
    return {
      ok: false,
      conflict: true,
      reason: `ese intento es del paso ${attempt.step}, no del paso ${requestedStep}; recargá la página`,
    };
  }
  if (attempt.status !== "failed") {
    return {
      ok: false,
      conflict: true,
      reason: `ese intento no quedó fallido (está "${attempt.status}"): no hay nada que reintentar`,
    };
  }

  if (!lead) return { ok: false, reason: "el lead no existe" };

  if (lead.opted_out === true) {
    return { ok: false, reason: "el lead pidió no recibir más mensajes (opt-out)" };
  }

  const status = lead.follow_up_status;
  if (status != null && TERMINAL_FOLLOW_UP_STATUSES.has(status)) {
    return { ok: false, reason: `el seguimiento de este lead está en estado "${status}"` };
  }

  if (lead.kommo_lead_id == null) {
    return { ok: false, reason: "el lead no tiene kommo_lead_id — no se puede enviar" };
  }

  if (!cfg || cfg.enabled !== true) {
    return { ok: false, reason: "el seguimiento está apagado en la configuración" };
  }

  const maxFollowUps = Number(cfg.max_follow_ups ?? 3);
  const step = Number(lead.follow_up_step ?? 0) + 1;
  if (requestedStep !== step) {
    return {
      ok: false,
      conflict: true,
      reason:
        `ese paso ya no es el que le toca al lead (va por el paso ${step - 1}; el siguiente es el ${step}). ` +
        "Recargá la página",
    };
  }
  if (step > maxFollowUps) {
    return { ok: false, reason: `ya alcanzó el máximo de ${maxFollowUps} seguimientos` };
  }

  return { ok: true, step, maxFollowUps };
}

export type RetryOutcome = {
  ok: boolean;
  status?: string;
  error?: string | null;
  skipped?: string;
  /** El paso pudo haberle llegado y no se confirmó: el panel ofrece reenviarlo
   *  solo si la persona lo confirma (confirm_resend). */
  unconfirmed?: boolean;
  /** El intento pedido ya no es el que corresponde (hubo uno posterior, o el lead
   *  avanzó): follow-up-scan responde 409. */
  conflict?: boolean;
};

/**
 * Qué le decimos al operador tras el reintento, a partir del resultado REAL del paso
 * (lo devuelve runClaimedFollowUp). Antes se reconstruía leyendo la fila más nueva del
 * log, que podía ser un fallo VIEJO del mismo paso y mostrarse como si fuera el actual.
 */
export function retryOutcomeFor(result: LeadRunResult): RetryOutcome {
  switch (result.kind) {
    case "refused":
      if (result.reason === "unconfirmed") return { ok: false, unconfirmed: true, skipped: result.message };
      if (result.reason === "superseded" || result.reason === "step_changed") {
        return { ok: false, conflict: true, skipped: result.message };
      }
      return { ok: false, skipped: result.message };
    case "sent":
      return { ok: true, status: "sent", error: null };
    case "failed":
      return { ok: false, status: "failed", error: result.error };
    case "unconfirmed":
      return { ok: false, status: "failed", unconfirmed: true, error: result.error };
    case "released":
      return { ok: false, skipped: result.reason };
    case "lease_lost":
      return { ok: false, skipped: "la reserva del seguimiento venció antes de enviar; no se envió nada" };
  }
}
