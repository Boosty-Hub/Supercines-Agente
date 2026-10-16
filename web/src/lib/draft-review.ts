// Al resolver desde el panel un «no responder» del agente (aprobar = «responder igual»,
// rechazar = «marcar revisado»), el lote deja de estar en revisión humana. generate-response
// marca requires_human_review en el lote cuando su compuerta frena un no_reply
// (_shared/agent-output.ts noReplyGate); sin limpiarlo, el lead quedaba para siempre en el
// filtro «revisión» aunque el humano ya lo hubiera resuelto.
import type { SupabaseClient } from "@supabase/supabase-js";

export function isNoReplyDraft(meta: unknown): boolean {
  return !!meta && typeof meta === "object" && (meta as Record<string, unknown>).no_reply === true;
}

/** Fail-soft: un error acá no deshace la aprobación/rechazo (se loguea). */
export async function clearNoReplyReview(supabase: SupabaseClient, draftId: string, meta: unknown): Promise<void> {
  if (!isNoReplyDraft(meta)) return;
  const { error } = await supabase
    .from("messages")
    .update({ requires_human_review: false })
    .eq("answered_by_draft_id", draftId)
    .eq("requires_human_review", true);
  if (error) console.error(`draft ${draftId}: no se pudo quitar la revisión del lote:`, error.message);
}
