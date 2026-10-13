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

export const RECOVER_FALLBACK_MAX_AGE_HOURS = 24;

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
