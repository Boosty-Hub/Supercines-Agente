import { truncateGraphemes } from "./text-safe.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { draftText } from "./draft-text.ts";
import { turn } from "./untrusted.ts";

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
  "id, direction, content, created_at, draft:drafts!messages_answered_by_draft_id_fkey(id, body, edited_body, status, sent_at, created_at)";

type HistoryRow = {
  id: string;
  direction: "inbound" | "outbound";
  content: string;
  created_at: string;
  draft: {
    id: string;
    body: string;
    edited_body: string | null;
    status: string;
    sent_at?: string | null;
    created_at?: string | null;
  } | null;
};

export type LeadHistoryOptions = {
  // IDs de mensajes a excluir del historial (típicamente el batch actual, que ya
  // se muestra aparte como "mensajes del lead"). Se excluyen DESPUÉS de traerlos.
  excludeMessageIds?: string[];
  // Cuántos mensajes recientes traer (antes de excluir). Default 24 (~12 turnos).
  maxMessages?: number;
  // Largo máximo por turno en caracteres, para acotar tokens. Default 600.
  truncateChars?: number;
  // Agrega a cada turno su instante (`t="YYYY-MM-DDTHH:mm"`, UTC). El seguimiento lo
  // necesita: decide según cuánto hace que el lead dejó de escribir. Default false.
  timestamps?: boolean;
  // Solo lo ANTERIOR a este instante (ISO): mensajes con created_at < before y drafts con
  // sent_at < before. El grader lo usa para ver la conversación previa a la respuesta que
  // evalúa, aunque después hayan llegado más mensajes. Default: sin corte.
  before?: string;
};

// Normaliza para comparar textos (espacios y mayúsculas no distinguen un eco de un
// mensaje distinto).
function norm(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function truncate(s: string, n: number): string {
  return truncateGraphemes((s ?? "").trim(), n, { ellipsis: "…" });
}

// Devuelve un transcript cronológico, UN TURNO POR LÍNEA, listo para inyectar en
// un prompt, o "" si no hay historial previo. FORMATO (cambió por seguridad):
//   <turno rol="lead">…</turno>  /  <turno rol="agente">…</turno>
// en vez de las líneas crudas "Lead: …" / "Agente: …". El texto del lead es
// entrada NO confiable: se sanea (ver _shared/untrusted.ts) para que nada dentro
// de un turno pueda falsificar un turno del agente ni cerrar el bloque. El
// llamador DEBE anteponer UNTRUSTED_NOTICE al insertarlo en el prompt. La firma
// y el tipo de retorno (string) no cambian. fail-soft ABSOLUTO: ante cualquier
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
  const at = (iso: string | null | undefined) => (opts.timestamps ? iso ?? null : null);
  try {
    // Traemos de más para compensar los excluidos del batch actual.
    // deno-lint-ignore no-explicit-any
    let q = (supabase as any)
      .from("messages")
      .select(HISTORY_SELECT)
      .eq("lead_id", leadId);
    if (opts.before) q = q.lt("created_at", opts.before);
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .limit(maxMessages + exclude.size);
    if (error || !data) return "";

    // Vienen desc (más nuevos primero) → a cronológico ascendente.
    const rows = (data as HistoryRow[]).slice().reverse();
    // Cada línea lleva su instante (ms) solo para poder intercalar los drafts que no cuelgan
    // de ningún inbound de la ventana (ver abajo); el orden del resto no cambia.
    const lines: { t: number; text: string }[] = [];
    const ms = (iso: string | null | undefined): number => {
      const v = iso ? Date.parse(iso) : NaN;
      return Number.isFinite(v) ? v : lines.length > 0 ? lines[lines.length - 1].t : 0;
    };
    // Si Kommo devuelve por webhook el mensaje que el propio agente envió (eco
    // saliente), existiría como fila `outbound` Y como draft enviado: la respuesta
    // aparecería duplicada. Se descartan las filas salientes cuyo texto coincide con
    // el de un draft enviado del historial. Un saliente DISTINTO (un asesor escribiendo
    // a mano en Kommo) sí se muestra como turno de la empresa.
    const sentBodies = new Set<string>();
    const seenDraftIds = new Set<string>();
    for (const m of rows) {
      const d = m.draft;
      if (d && (d.status === "sent" || d.status === "auto_sent")) {
        sentBodies.add(norm(draftText(d)));
        seenDraftIds.add(d.id);
      }
    }
    // Drafts enviados DENTRO de la ventana de tiempo cuyo inbound quedó fuera de la ventana
    // de mensajes (o aún no está en `rows`): sin esto su eco saliente no se reconoce y la
    // respuesta se duplica; y si se descartara el eco sin emitir el draft, la respuesta
    // desaparecería. Se consultan por separado y se emiten como turno del agente.
    const oldest = rows.length > 0 ? rows[0].created_at : null;
    const extraDrafts: { id: string; text: string; at: string | null }[] = [];
    if (oldest) {
      try {
        // deno-lint-ignore no-explicit-any
        let dq = (supabase as any)
          .from("drafts")
          .select("id, body, edited_body, status, sent_at, created_at, message_id, messages!drafts_message_id_fkey!inner(lead_id)")
          .eq("messages.lead_id", leadId)
          .in("status", ["sent", "auto_sent"])
          .gte("sent_at", oldest);
        if (opts.before) dq = dq.lt("sent_at", opts.before);
        const { data: dd } = await dq
          .order("sent_at", { ascending: true })
          .limit(maxMessages);
        for (const d of (dd ?? []) as (NonNullable<HistoryRow["draft"]> & { message_id: string })[]) {
          if (!d || seenDraftIds.has(d.id) || exclude.has(d.message_id)) continue;
          const text = draftText(d);
          if (!text || !text.trim()) continue;
          sentBodies.add(norm(text));
          extraDrafts.push({ id: d.id, text, at: d.sent_at ?? d.created_at ?? null });
        }
      } catch (_e) {
        // fail-soft: sin esta consulta el historial es el de antes (solo lo que cuelga de los inbound).
      }
    }
    // Un draft cubre TODO el batch del lead (varios inbound consecutivos apuntan
    // al mismo draft). La respuesta del agente, cronológicamente, va DESPUÉS del
    // último mensaje de su batch — así que diferimos su emisión hasta detectar
    // que el batch terminó (cambia el draft.id o aparece una fila que no es de
    // ese draft). Esto también deduplica: la respuesta se emite una sola vez por
    // batch, no una por cada mensaje. (Si la emitiéramos tras el primer inbound,
    // el agente podría creer que el resto del batch quedó sin responder.)
    let pendingBody: string | null = null;
    let pendingDraftId: string | null = null;
    let pendingAt: string | null = null;
    let pendingRawAt: string | null = null;
    const flush = () => {
      if (pendingBody !== null) {
        lines.push({ t: ms(pendingRawAt), text: turn("agente", pendingBody, { maxChars: truncChars, at: pendingAt }) });
        pendingBody = null;
        pendingDraftId = null;
        pendingAt = null;
        pendingRawAt = null;
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
      const rol = m.direction === "inbound" ? "lead" : "agente";
      if (m.direction === "outbound" && sentBodies.has(norm(m.content))) continue; // eco de un draft ya emitido
      if (m.content && m.content.trim()) {
        lines.push({ t: ms(m.created_at), text: turn(rol, m.content, { maxChars: truncChars, at: at(m.created_at) }) });
      }
      // Diferimos la respuesta del agente hasta cerrar su batch.
      if (sentDraft) {
        const body = draftText(sentDraft);
        if (body && body.trim()) {
          pendingBody = body;
          pendingDraftId = sentDraft.id;
          pendingAt = at(sentDraft.sent_at ?? sentDraft.created_at ?? null);
          pendingRawAt = sentDraft.sent_at ?? sentDraft.created_at ?? null;
        }
      }
    }
    flush();
    // Intercala los drafts sin inbound en la ventana por su instante de envío.
    for (const x of extraDrafts) {
      const t = ms(x.at);
      const idx = lines.findIndex((l) => l.t > t);
      const entry = { t, text: turn("agente", x.text, { maxChars: truncChars, at: at(x.at) }) };
      if (idx === -1) lines.push(entry);
      else lines.splice(idx, 0, entry);
    }
    return lines.map((l) => l.text).join("\n");
  } catch (_e) {
    return "";
  }
}
