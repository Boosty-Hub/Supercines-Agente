// Tiempos del movimiento de etapa desde el panel (puro, sin imports).
//
// La ruta POST /api/leads/[id]/stage reserva el lead con claim_lead_move (0061) ANTES de
// llamar a Kommo y la suelta al terminar. La reserva vence sola (TTL) para que un servidor
// caído no bloquee el lead; si venciera MIENTRAS el movimiento sigue vivo, un segundo
// movimiento podría salir en paralelo y llegar a Kommo en orden inverso. Por eso el TTL se
// deriva del peor caso real de moveLeadInKommo (lib/kommo.ts usa estas mismas constantes),
// con margen para la lectura de config y la RPC apply_lead_position que van antes de soltar.

/** Timeout de cada PATCH a Kommo (cubre también la lectura del cuerpo: misma señal). */
export const KOMMO_MOVE_TIMEOUT_MS = 8_000;
/** Espera antes del único reintento tras un 429. */
export const KOMMO_MOVE_429_BACKOFF_MS = 1_200;
/** Intentos de PATCH (1 + 1 reintento tras 429). */
export const KOMMO_MOVE_ATTEMPTS = 2;

/** Peor caso del PATCH a Kommo: todos los intentos agotan su timeout + las esperas entre ellos. */
export function kommoMoveWorstCaseMs(): number {
  return KOMMO_MOVE_ATTEMPTS * KOMMO_MOVE_TIMEOUT_MS + (KOMMO_MOVE_ATTEMPTS - 1) * KOMMO_MOVE_429_BACKOFF_MS;
}

/**
 * TTL de la reserva del lead (segundos). 45 s = peor caso de Kommo (17,2 s) + holgura amplia
 * para config, la RPC de registro y un servidor lento. Es también el default de
 * claim_lead_move en la base; la ruta lo pasa explícito para que haya una sola fuente.
 */
export const MOVE_CLAIM_TTL_SECONDS = 45;
