// Estados de `drafts.status` (CHECK drafts_status_check, última definición en la
// migración 0087). `draft-status.test.ts` falla si esta lista y la de la base divergen.
//
//   pending ─aprobar─▶ approved ─(publish-to-kommo reserva)─▶ publishing ─▶ auto_sent | failed
//                                                                   │       (pending si el guard
//                                                                   │        de fuga lo bloquea)
//   `skipped` = el agente decidió NO responder a propósito (<sin_respuesta>, 0087): terminal,
//   sin cuerpo; el motivo está en agent_metadata.no_reply_reason.
//   `publishing` = «enviando…»: lo tiene reservado un worker de publish-to-kommo y el
//   panel NO puede tocarlo (ni aprobar, ni rechazar, ni editar).
export const DRAFT_STATUSES = [
  "pending",
  "approved",
  "publishing",
  "sent",
  "auto_sent",
  "rejected",
  "failed",
  "skipped",
] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/**
 * Desde dónde el panel puede aprobar (o re-aprobar con una edición) un draft. `skipped`
 * («el agente decidió no responder») también: «responder igual», con texto obligatorio
 * (la ruta approve rechaza un draft sin texto).
 */
export const DRAFT_APPROVABLE_STATUSES: readonly DraftStatus[] = ["pending", "approved", "skipped"];

/**
 * Desde dónde el panel puede rechazar un draft (aprobado = todavía no reservado: se cancela).
 * Rechazar un `skipped` = «marcar revisado»: el humano confirma que no se responde.
 */
export const DRAFT_REJECTABLE_STATUSES: readonly DraftStatus[] = ["pending", "approved", "skipped"];

/** Respuesta 409 cuando el draft ya no admite la acción (se está enviando o ya se resolvió). */
export const DRAFT_NOT_ACTIONABLE =
  "Este borrador ya se está enviando o ya se resolvió. Recargá la conversación para ver su estado.";
