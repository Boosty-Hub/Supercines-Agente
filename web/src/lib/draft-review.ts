// Al resolver desde el panel un «no responder» del agente (aprobar = «responder igual»,
// rechazar = «marcar revisado»), el lote deja de estar en revisión humana. generate-response
// marca requires_human_review en el lote cuando su compuerta frena un no_reply
// (_shared/agent-output.ts noReplyGate) y guarda QUÉ mensajes marcó en
// agent_metadata.no_reply_marked_ids. Acá se desmarcan exactamente esos y solo si siguen
// perteneciendo a ESE lote (answered_by_draft_id = el draft): nunca un flag que puso el
// clasificador (toxicidad, urgencia) ni mensajes de otro lote del lead. Lo llaman las
// rutas approve/reject, ambas con alcance `operacion` (middleware + requireScope).
import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids de mensajes que la compuerta marcó (valida forma: es dato del draft, no confiar). */
export function markedReviewIds(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") return [];
  const m = meta as Record<string, unknown>;
  if (m.no_reply !== true || !Array.isArray(m.no_reply_marked_ids)) return [];
  return m.no_reply_marked_ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).slice(0, 200);
}

/** Fail-soft: un error acá no deshace la aprobación/rechazo (se loguea). */
export async function clearNoReplyReview(supabase: SupabaseClient, draftId: string, meta: unknown): Promise<void> {
  const ids = markedReviewIds(meta);
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("messages")
    .update({ requires_human_review: false })
    .in("id", ids)
    .eq("answered_by_draft_id", draftId)
    .eq("requires_human_review", true);
  if (error) console.error(`draft ${draftId}: no se pudo quitar la revisión del lote:`, error.message);
}
