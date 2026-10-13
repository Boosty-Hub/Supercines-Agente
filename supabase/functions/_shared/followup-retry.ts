// _shared/followup-retry.ts
//
// Lógica PURA del reintento MANUAL de un seguimiento (botón "Reintentar" en
// /seguimiento, sobre un `follow_ups` que quedó en `failed`). Separada de
// follow-up-scan/index.ts para poder probar la decisión sin levantar
// Supabase ni Kommo: acá se decide SI se puede reintentar y CON QUÉ MOTIVO —
// nunca se llama a nada por red.
//
// El reintento es una decisión humana explícita (mismo criterio que el envío
// manual de publish-to-kommo), así que el llamador (`retryOne` en index.ts)
// saltea la rotación del barrido automático y el reloj `min_gap_hours`. Lo
// que este módulo SÍ hace cumplir son los gates que protegen al cliente:
// opt-out, estados terminales del seguimiento, falta de `kommo_lead_id`, el
// seguimiento apagado en la config, y el tope de `max_follow_ups`. El horario
// laboral NO vive acá — lo evalúa el llamador con `isBusinessHours` de
// `business-hours.ts`, que ya es pura y ya tiene su propio contrato.

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
  /** Paso a reintentar: follow_up_step + 1 (el siguiente que le toca al lead). */
  step: number;
  maxFollowUps: number;
};

export type RetryGateBlocked = {
  ok: false;
  /** Motivo LEGIBLE para el operador — nunca un silencio. */
  reason: string;
};

export type RetryGateResult = RetryGateOk | RetryGateBlocked;

const TERMINAL_FOLLOW_UP_STATUSES = new Set(["responded", "stopped", "exhausted"]);

/**
 * Decide si un lead puede reintentar su seguimiento AHORA MISMO — sin mirar
 * todavía horario laboral (eso es del llamador) ni si el paso calculado tiene
 * una plantilla habilitada en `follow_up_steps` (eso exige una consulta
 * aparte que tampoco es responsabilidad de esta función pura).
 */
export function evaluateRetryGate(
  lead: RetryLeadRow | null | undefined,
  cfg: RetryConfigRow | null | undefined
): RetryGateResult {
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
  if (step > maxFollowUps) {
    return { ok: false, reason: `ya alcanzó el máximo de ${maxFollowUps} seguimientos` };
  }

  return { ok: true, step, maxFollowUps };
}

export type LastFollowUpRow = {
  status: string;
  error: string | null;
  step: number;
};

export type RetryOutcome = {
  ok: boolean;
  status?: string;
  error?: string | null;
  skipped?: string;
};

/**
 * `processLead` no devuelve nada: inserta la fila del intento en `follow_ups`.
 * Para decirle al operador qué pasó de verdad —en vez de un "listo" que igual
 * pudo haber fallado— el llamador lee la fila MÁS NUEVA de ese lead y la pasa
 * acá junto con el paso que se pidió reintentar.
 *
 * Si no hay fila, o su `step` no coincide con el pedido, fue un skip
 * silencioso de los de adentro de `processLead` (etapa o responsable fuera
 * del whitelist EN VIVO contra Kommo, plantilla mal configurada, o el agente
 * decidió no escribir) — nunca hay que confundirlo con un envío real.
 */
export function interpretRetryOutcome(
  last: LastFollowUpRow | null | undefined,
  expectedStep: number
): RetryOutcome {
  if (!last || Number(last.step) !== Number(expectedStep)) {
    return {
      ok: false,
      skipped:
        "el seguimiento se salteó sin intentar el envío (etapa o responsable fuera de la lista, o el agente decidió no escribir)",
    };
  }
  return {
    ok: last.status === "sent",
    status: last.status,
    error: last.error ?? null,
  };
}
