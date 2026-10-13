// _shared/claim-batch.ts
//
// Lógica PURA de la decisión que sigue al claim atómico de
// `claim_message_batch` (RPC, migración 0060). Separada de
// generate-response/index.ts para poder probar la interpretación del
// resultado sin levantar Supabase: acá se decide si GANAMOS el batch
// completo, si hay que LIBERAR lo tomado a medias, y qué mensaje dejar en el
// log — nunca se llama a la RPC ni se toca una tabla desde este archivo.
//
// Contexto: varias invocaciones de generate-response corren en paralelo (el
// fire-and-forget del webhook, el sweep de pg_cron cada minuto, el trigger
// de process-inbound y el fan-out encadenado hasta MAX_CONCURRENT). Antes
// del claim atómico, el batch se elegía con un SELECT y se marcaba con un
// UPDATE aparte — dos pasos sin relación entre sí — así que dos invocaciones
// concurrentes podían elegir el MISMO lote y las dos terminaban
// respondiendo. Medido en KIA (otro cliente nacido de este mismo template):
// 5 drafts del mismo message_id en 800 ms, 247 respuestas duplicadas
// REALMENTE ENVIADAS en un día. El llamador exige el batch COMPLETO: si la
// RPC devuelve menos filas de las pedidas, otra invocación ya se llevó parte
// (o todo) el lote y NO hay que tratarlo como un error.

export type ClaimWon = {
  won: true;
};

export type ClaimLost = {
  won: false;
  /**
   * true cuando la RPC alcanzó a marcar ALGUNAS filas antes de perder el
   * resto del lote — hay que liberarlas (answered_by_draft_id = null) o
   * quedan huérfanas: cubiertas por un draft que este mismo llamador va a
   * borrar y que entonces nunca las va a responder ni a liberar por su
   * cuenta (el `on delete set null` del FK solo dispara si el draft SE
   * BORRA, y acá lo borramos DESPUÉS de este release — el orden importa).
   */
  needsRelease: boolean;
  /** Mensaje LEGIBLE para el log — nunca un error falso cuando en realidad
   *  ganó otra invocación de forma legítima (eso es el camino normal bajo
   *  concurrencia, no una falla). */
  message: string;
};

export type ClaimResult = ClaimWon | ClaimLost;

/**
 * Interpreta la respuesta de `supabase.rpc("claim_message_batch", …)`.
 *
 * - `claimErr` presente → la RPC no corrió (permisos, conexión, etc.). Es
 *   una única sentencia SQL: si falló, no comprometió ninguna fila, así que
 *   no hace falta liberar nada.
 * - `claimedCount === totalIds` → ganamos el lote COMPLETO.
 * - cualquier otro valor (incluido 0) → perdimos. Si `claimedCount > 0`,
 *   alcanzamos a marcar algunas filas antes de que otra invocación se
 *   llevara el resto — esas SÍ hay que liberarlas.
 */
export function evaluateClaim(
  claimedCount: number | null | undefined,
  claimErr: { message: string } | null | undefined,
  totalIds: number
): ClaimResult {
  if (claimErr) {
    return {
      won: false,
      needsRelease: false,
      message: `claim_message_batch error: ${claimErr.message}`,
    };
  }

  const claimed = claimedCount ?? 0;
  if (claimed === totalIds) {
    return { won: true };
  }

  return {
    won: false,
    needsRelease: claimed > 0,
    message: `claim perdido: ${claimed}/${totalIds} filas — otra invocación tomó este batch`,
  };
}
