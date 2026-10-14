// _shared/classify-recovery.ts
// Reglas puras de la recuperación de clasificaciones fallidas (process-inbound).
//
// Un fallo transitorio del proveedor no cuenta como intento del mensaje (ver
// isTransientProviderError), así que lo acota la ventana de edad
// (answer_max_age_hours, o RECOVER_FALLBACK_MAX_AGE_HOURS si es 0). Pero si la caída
// dura MÁS que esa ventana, el mensaje salía del select de recuperación sin
// clasificar y sin requires_human_review: nadie lo veía, y generate-response tampoco
// lo respondía (no tiene vertical). Al vencer la ventana se lo manda a revisión humana
// con un error explícito, y el prefijo "recover:" lo saca del select para siempre.

import type { AlertInsert } from "./alerts.ts";

export const RECOVER_FALLBACK_MAX_AGE_HOURS = 24;

/**
 * Cota INFERIOR del barrido de vencidos: solo se vencen mensajes de hasta
 * (ventana + RECOVER_EXPIRE_GRACE_DAYS) de antigüedad. Los más viejos se IGNORAN sin
 * tocarlos (siguen como estaban, sin revisión humana ni alerta).
 *
 * Por qué: el barrido corre cada minuto, así que en régimen todo mensaje fallido pasa por
 * la franja [ventana, ventana + 3 días] y se vence ahí. Sin cota, el primer barrido tras
 * el despliegue tomaba TODO el histórico con classification.error (meses) y lo mandaba a
 * revisión humana: conversaciones muertas hace semanas inundando el inbox y las alertas.
 * Los 3 días cubren un cron caído o un sistema pausado durante un fin de semana largo.
 */
export const RECOVER_EXPIRE_GRACE_DAYS = 3;

/**
 * Franja de created_at que el barrido de vencidos puede tocar: [from, to).
 * `to` = ahora - ventana (venció); `from` = `to` - RECOVER_EXPIRE_GRACE_DAYS.
 */
export function expireSelectionRange(nowMs: number, windowHours: number): { fromIso: string; toIso: string } {
  const toMs = nowMs - windowHours * 3_600_000;
  const fromMs = toMs - RECOVER_EXPIRE_GRACE_DAYS * 24 * 3_600_000;
  return { fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() };
}

/** Marca de la alerta agregada del barrido (metadata.source) para deduplicarla. */
export const EXPIRED_ALERT_SOURCE = "recover_expired";
/**
 * Una alerta agregada por ventana de EXPIRED_ALERT_DEDUPE_HOURS: si ya hay una SIN
 * reconocer de esta fuente creada en ese lapso, el barrido suma a esa (no inserta otra).
 * El cron pasa cada minuto: sin dedupe, una caída larga del proveedor generaba una alerta
 * por minuto (y cada una iba a Slack).
 */
export const EXPIRED_ALERT_DEDUPE_HOURS = 6;

// AlertInsert: el `kind` tiene que ser un tipo registrado (_shared/alert-kinds.ts).
export type ExpiredAlertRow = AlertInsert & {
  kind: "human_review_needed";
  severity: "warning";
  title: string;
  description: string;
  ref_table: "messages";
  metadata: { source: string; expired: number; window_hours: number };
};

function expiredAlertText(expired: number, windowHours: number) {
  return {
    title: `${expired} mensaje(s) quedaron sin clasificar y pasaron a revision humana`,
    description:
      `El proveedor de IA fallo mas de ${windowHours} h seguidas (answer_max_age_hours), asi que el agente ya no puede ` +
      "responder esos mensajes por su cuenta. Revisalos en el inbox y responde a mano si corresponde.",
  };
}

/**
 * Qué hacer con la alerta agregada tras vencer `expired` mensajes. `existing` = la alerta
 * sin reconocer de esta fuente creada en las últimas EXPIRED_ALERT_DEDUPE_HOURS (o null).
 * Con una existente se ACTUALIZA sumando el conteo (el panel muestra el total, sin un
 * aviso nuevo); sin ella se inserta una.
 */
export function expiredAlertPlan(
  existing: { id: string; metadata: unknown } | null,
  expired: number,
  windowHours: number,
):
  | { action: "insert"; row: ExpiredAlertRow }
  | { action: "update"; id: string; patch: Pick<ExpiredAlertRow, "title" | "description" | "metadata"> } {
  if (existing) {
    const meta = (existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}) as Record<
      string,
      unknown
    >;
    const prev = Number(meta.expired);
    const total = (Number.isFinite(prev) && prev > 0 ? prev : 0) + expired;
    return {
      action: "update",
      id: existing.id,
      patch: {
        ...expiredAlertText(total, windowHours),
        metadata: { source: EXPIRED_ALERT_SOURCE, expired: total, window_hours: windowHours },
      },
    };
  }
  return {
    action: "insert",
    row: {
      kind: "human_review_needed",
      severity: "warning",
      ...expiredAlertText(expired, windowHours),
      ref_table: "messages",
      metadata: { source: EXPIRED_ALERT_SOURCE, expired, window_hours: windowHours },
    },
  };
}

/** Ventana efectiva de recuperación en horas (0 = sin límite de frescura → tope de respaldo). */
export function recoverWindowHours(answerMaxAgeHours: number): number {
  return answerMaxAgeHours > 0 ? answerMaxAgeHours : RECOVER_FALLBACK_MAX_AGE_HOURS;
}

/** Cambios para un mensaje cuya ventana de recuperación venció sin poder clasificarse. */
export function expiredClassificationUpdate(
  prevClassification: unknown,
  windowHours: number,
): { requires_human_review: true; classification: Record<string, unknown> } {
  const prev = (prevClassification && typeof prevClassification === "object"
    ? prevClassification
    : {}) as Record<string, unknown>;
  return {
    requires_human_review: true,
    classification: {
      ...prev,
      // El prefijo "recover:" lo excluye del select de recuperación (no se reintenta más).
      error: `recover: ventana de ${windowHours} h vencida sin poder clasificar (${String(prev.error ?? "desconocido")})`,
      recover_expired: true,
    },
  };
}
