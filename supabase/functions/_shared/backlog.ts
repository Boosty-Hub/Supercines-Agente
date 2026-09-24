// _shared/backlog.ts
// Decide si una fila del backlog de inbound_queue llegó hace demasiado
// tiempo como para clasificarla/responderla. Lógica pura (sin I/O) para
// poder testearla sin mockear Supabase/Anthropic — ver backlog.test.ts.
//
// Refleja la MISMA ventana de frescura que usa generate-response
// (`answer_max_age_hours`, kommo_publish_config) para elegir qué mensajes
// contesta: si generate-response igual descartaría el mensaje por viejo, no
// tiene sentido gastar una llamada a Haiku clasificándolo primero.

/**
 * @param queuedAt    Momento en que la fila llegó a inbound_queue
 *                     (created_at del webhook, NO el momento en que se
 *                     procesa — puede ser horas/días antes si el sistema
 *                     estuvo `system_halted` o hubo un apagón de Kommo).
 * @param now          Date.now() del momento de la decisión (inyectado como
 *                     parámetro para poder testear sin mockear el reloj).
 * @param maxAgeHours  `kommo_publish_config.answer_max_age_hours`. 0 (o
 *                     cualquier valor <= 0) = sin límite — nunca es backlog
 *                     viejo (comportamiento legacy).
 */
export function isStaleBacklog(
  queuedAt: string | number | Date,
  now: number,
  maxAgeHours: number
): boolean {
  if (!(maxAgeHours > 0)) return false;
  const queuedMs = new Date(queuedAt).getTime();
  // Fail-open: un timestamp inválido no debe bloquear la clasificación.
  if (!Number.isFinite(queuedMs)) return false;
  return now - queuedMs > maxAgeHours * 3600_000;
}
