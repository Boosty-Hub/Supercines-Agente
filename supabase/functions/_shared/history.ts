import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Reconstrucción DETERMINÍSTICA del historial de un lead, leída de la DB.
//
// Por qué existe: el contexto histórico de la conversación estaba delegado 100%
// a que el Managed Agent escribiera/leyera `<leads>/<lead_id>/conversation.md`
// en el Memory Store — un tool call no determinístico que el modelo puede
// omitir. Cuando lo omite, el agente (y el clasificador) se quedan solo con el
// mensaje actual y responden sin contexto. Este helper trae el transcript real
// desde `messages` + `drafts` para inyectarlo en el prompt, sin depender de la
// disciplina del modelo.
//
// Sigue el patrón probado de dreams-run: cada inbound (messages.content) se
// empareja con el draft que respondió su batch vía el FK
// messages_answered_by_draft_id_fkey. OJO: hay DOS FKs entre messages y drafts
// (drafts.message_id y messages.answered_by_draft_id) — el embed sin desambiguar
// da PGRST201. Las respuestas enviadas NO se guardan como messages outbound:
// viven en drafts.body / edited_body (publish-to-kommo solo marca el draft
// auto_sent/sent), por eso reconstruimos vía el join y no leyendo outbound.
const HISTORY_SELECT =
  "id, direction, content, created_at, draft:drafts!messages_answered_by_draft_id_fkey(id, body, edited_body, status)";

type HistoryRow = {
  id: string;
  direction: "inbound" | "outbound";
  content: string;
  created_at: string;
  draft: { id: string; body: string; edited_body: string | null; status: string } | null;
};

export type LeadHistoryOptions = {
  // IDs de mensajes a excluir del historial (típicamente el batch actual, que ya
  // se muestra aparte como "mensajes del lead"). Se excluyen DESPUÉS de traerlos.
  excludeMessageIds?: string[];
  // Cuántos mensajes recientes traer (antes de excluir). Default 24 (~12 turnos).
  maxMessages?: number;
  // Largo máximo por turno en caracteres, para acotar tokens. Default 600.
  truncateChars?: number;
};

function truncate(s: string, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// Devuelve un transcript cronológico "Lead:/Agente:" listo para inyectar en un
// prompt, o "" si no hay historial previo. fail-soft ABSOLUTO: ante cualquier
// error de query devuelve "" y el llamador cae al comportamiento previo (nunca
// rompe la clasificación ni la respuesta).
export async function fetchLeadHistory(
  supabase: SupabaseClient,
  leadId: string,
  opts: LeadHistoryOptions = {}
): Promise<string> {
  const maxMessages = opts.maxMessages ?? 24;
  const truncChars = opts.truncateChars ?? 600;
  const exclude = new Set(opts.excludeMessageIds ?? []);
  try {
    // Traemos de más para compensar los excluidos del batch actual.
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (supabase as any)
      .from("messages")
      .select(HISTORY_SELECT)
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(maxMessages + exclude.size);
    if (error || !data) return "";

    // Vienen desc (más nuevos primero) → a cronológico ascendente.
    const rows = (data as HistoryRow[]).slice().reverse();
    const lines: string[] = [];
    // Un draft cubre TODO el batch del lead (varios inbound consecutivos apuntan
    // al mismo draft). La respuesta del agente, cronológicamente, va DESPUÉS del
    // último mensaje de su batch — así que diferimos su emisión hasta detectar
    // que el batch terminó (cambia el draft.id o aparece una fila que no es de
    // ese draft). Esto también deduplica: la respuesta se emite una sola vez por
    // batch, no una por cada mensaje. (Si la emitiéramos tras el primer inbound,
    // el agente podría creer que el resto del batch quedó sin responder.)
    let pendingBody: string | null = null;
    let pendingDraftId: string | null = null;
    const flush = () => {
      if (pendingBody !== null) {
        lines.push(`Agente: ${truncate(pendingBody, truncChars)}`);
        pendingBody = null;
        pendingDraftId = null;
      }
    };
    for (const m of rows) {
      if (exclude.has(m.id)) continue;
      // Draft enviado que respondió este inbound (si lo hay).
      const draft = m.draft;
      const sentDraft =
        m.direction === "inbound" &&
        draft &&
        (draft.status === "sent" || draft.status === "auto_sent")
          ? draft
          : null;
      // Si veníamos acumulando una respuesta de OTRO batch, este es el corte:
      // emitila antes de seguir (ya pasamos el último mensaje de aquel batch).
      if (pendingDraftId !== null && (!sentDraft || sentDraft.id !== pendingDraftId)) {
        flush();
      }
      const who = m.direction === "inbound" ? "Lead" : "Agente";
      if (m.content && m.content.trim()) {
        lines.push(`${who}: ${truncate(m.content, truncChars)}`);
      }
      // Diferimos la respuesta del agente hasta cerrar su batch.
      if (sentDraft) {
        const body = sentDraft.edited_body ?? sentDraft.body;
        if (body && body.trim()) {
          pendingBody = body;
          pendingDraftId = sentDraft.id;
        }
      }
    }
    flush();
    return lines.join("\n");
  } catch (_e) {
    return "";
  }
}
