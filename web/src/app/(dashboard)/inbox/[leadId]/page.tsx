import Link from "next/link";
import { Suspense } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Badge, EmptyState, MessageSquare } from "@/components/ui";
import { timeAgo } from "@/lib/time-ago";
import { draftText } from "@/lib/draft-text";
import { fetchLeadStage } from "@/lib/kommo";
import { configValue } from "@/lib/runtime-config";
import {
  initials,
  INBOX_URL_PARAMS,
  fetchPublishCfg,
  fetchBoardPipelines,
  toAgentStatusCfg,
  type AgentStatusCfg,
} from "@/lib/inbox-data";
import DraftActions from "../draft-actions";
import ScrollToBottom from "../scroll-to-bottom";
import ReviewActions from "../review-actions";
import ChannelIcon from "../channel-icon";
import { KommoLeadLink } from "../kommo-lead-link";
import { computeAgentStatus, AgentStatusBadge } from "../agent-status";
import ConversationRealtime from "../conversation-realtime";
import MoveStageMenu from "../move-stage-menu";
import LivePositionSync from "../live-position-sync";

export const dynamic = "force-dynamic";

// Cuántos mensajes se muestran. Son los ÚLTIMOS: pedirlos ascendente con limit
// trae los 100 más VIEJOS y en las conversaciones largas no se vería lo reciente.
const MAX_MESSAGES = 100;

type MessageRow = {
  id: string;
  direction: string;
  content: string;
  source: string | null;
  kommo_message_id: string | null;
  requires_human_review: boolean;
  answered_by_draft_id: string | null;
  classification: Record<string, unknown> | null;
  created_at: string;
  media_url: string | null;
  media_kind: string | null;
  media_status: string | null;
  media_error: string | null;
  is_comment: boolean;
  verticals: { slug: string } | null;
};
type DraftRow = {
  id: string;
  message_id: string;
  body: string;
  edited_body: string | null;
  status: string;
  agent_metadata: Record<string, unknown> | null;
  sent_at: string | null;
  created_at: string;
};
type StageEventRow = {
  id: string;
  from_stage_id: number | null;
  from_pipeline_id: number | null;
  to_stage_id: number;
  pipeline_id: number | null;
  from_stage_name: string | null;
  to_stage_name: string | null;
  pipeline_name: string | null;
  moved_by: "agente" | "kommo";
  actor_name: string | null;
  created_at: string;
};
type LeadRow = {
  id: string;
  display_name: string | null;
  channel: string | null;
  kommo_lead_id: number | null;
  kommo_pipeline_id: number | null;
  kommo_stage_id: number | null;
};

type StageInfo = { name: string; pipelineName: string; color: string | null };
/**
 * Nombres de etapa desde la copia local (kommo_stages, 0061): no se le piden los
 * pipelines a Kommo en cada apertura. `byPair` resuelve 142/143 con el pipeline;
 * `byId` es el respaldo para eventos históricos que no guardaron pipeline (con
 * 142/143 gana el pipeline principal).
 */
type StageMaps = { byPair: Map<string, StageInfo>; byId: Map<number, StageInfo> };

async function loadStageMaps(supabase: SupabaseClient): Promise<StageMaps> {
  const byPair = new Map<string, StageInfo>();
  const byId = new Map<number, StageInfo>();
  const [{ data: pipes }, { data: stages }] = await Promise.all([
    supabase.from("kommo_pipelines").select("id, name, is_main, sort"),
    supabase.from("kommo_stages").select("pipeline_id, id, name, color"),
  ]);
  const ordered = [...(pipes ?? [])].sort(
    (a, b) => Number(b.is_main) - Number(a.is_main) || (a.sort as number) - (b.sort as number)
  );
  const nameOf = new Map(ordered.map((p) => [Number(p.id), p.name as string]));
  const rank = new Map(ordered.map((p, i) => [Number(p.id), i]));
  const sorted = [...(stages ?? [])].sort(
    (a, b) => (rank.get(Number(a.pipeline_id)) ?? 99) - (rank.get(Number(b.pipeline_id)) ?? 99)
  );
  for (const s of sorted) {
    const info: StageInfo = {
      name: s.name as string,
      pipelineName: nameOf.get(Number(s.pipeline_id)) ?? "",
      color: (s.color as string | null) ?? null,
    };
    byPair.set(`${Number(s.pipeline_id)}:${Number(s.id)}`, info);
    if (!byId.has(Number(s.id))) byId.set(Number(s.id), info);
  }
  return { byPair, byId };
}

function resolveStage(maps: StageMaps, stageId: number, pipelineId: number | null): StageInfo | undefined {
  return (pipelineId != null ? maps.byPair.get(`${pipelineId}:${stageId}`) : undefined) ?? maps.byId.get(stageId);
}

export default async function ConversationPage(
  props: {
    params: Promise<{ leadId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  // Estado del inbox (filtros, vista, pipeline), para que "← Volver" (móvil) lo conserve.
  const backParams = new URLSearchParams();
  for (const k of INBOX_URL_PARAMS) {
    const v = searchParams[k];
    if (typeof v === "string" && v) backParams.set(k, v);
  }
  const backQS = backParams.toString();
  const supabase = await createSupabaseServerClient();
  const leadId = params.leadId;
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return <NotFound />;

  // Todo en paralelo: lead, mensajes, drafts, eventos, config y pipelines.
  const [leadRes, msgsRes, draftsRes, evtsRes, reviewRes, stageMaps, pubCfg, kommoSubdomain, boardPipelines] =
    await Promise.all([
      supabase
        .from("leads")
        .select("id, display_name, channel, kommo_lead_id, kommo_pipeline_id, kommo_stage_id")
        .eq("id", leadId)
        .maybeSingle(),
      supabase
        .from("messages")
        .select(
          "id, direction, content, source, kommo_message_id, requires_human_review, answered_by_draft_id, classification, created_at, media_url, media_kind, media_status, media_error, is_comment, verticals(slug)"
        )
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(MAX_MESSAGES),
      // Drafts por el lead de su mensaje (embed !inner con el FK explícito: hay
      // dos FK entre drafts y messages): una consulta en paralelo en vez de
      // esperar los ids de los mensajes.
      supabase
        .from("drafts")
        .select(
          "id, message_id, body, edited_body, status, agent_metadata, sent_at, created_at, messages!drafts_message_id_fkey!inner(lead_id)"
        )
        .eq("messages.lead_id", leadId),
      supabase
        .from("lead_stage_events")
        .select(
          "id, from_stage_id, from_pipeline_id, to_stage_id, pipeline_id, from_stage_name, to_stage_name, pipeline_name, moved_by, actor_name, created_at"
        )
        .eq("lead_id", leadId)
        .order("created_at", { ascending: true }),
      // Sobre TODOS los mensajes del lead, no solo los que se muestran.
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", leadId)
        .eq("direction", "inbound")
        .eq("requires_human_review", true),
      loadStageMaps(supabase),
      fetchPublishCfg(supabase),
      configValue("KOMMO_SUBDOMAIN").then((v) => v || null),
      // Para el "Mover a…" (fail-open: sin pipelines, no se muestra el menú).
      fetchBoardPipelines(supabase).catch(() => []),
    ]);

  const lead = (leadRes.data as LeadRow | null) ?? null;
  if (!lead) return <NotFound />;

  // Llegan del más nuevo al más viejo; se dan vuelta para leer en orden.
  const messages: MessageRow[] = ((msgsRes.data ?? []) as unknown as Array<
    MessageRow & { verticals: { slug: string }[] | { slug: string } | null }
  >)
    .map((m) => ({
      ...m,
      is_comment: (m as { is_comment?: boolean }).is_comment === true,
      verticals: Array.isArray(m.verticals) ? m.verticals[0] ?? null : m.verticals,
    }))
    .reverse();
  const draftsByMessage = new Map<string, DraftRow>();
  for (const d of (draftsRes.data ?? []) as unknown as DraftRow[]) draftsByMessage.set(d.message_id, d);
  const stageEvents = (evtsRes.data ?? []) as StageEventRow[];
  const hasReviewPending = (reviewRes.count ?? 0) > 0;

  const agentCfg = toAgentStatusCfg(pubCfg);
  const leadName = lead.display_name ?? `Lead ${lead.kommo_lead_id ?? "?"}`;
  const msgIds = messages.map((m) => m.id);

  return (
    <>
      <ConversationRealtime leadId={lead.id} messageIds={msgIds} />
      {/* Header sticky de la conversación */}
      <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <Link
            href={backQS ? `/inbox?${backQS}` : "/inbox"}
            className="-ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 lg:hidden"
          >
            ← Volver
          </Link>
          <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[11px] font-semibold text-neutral-600 lg:flex">
            {initials(leadName)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight text-neutral-900">{leadName}</p>
            <p className="flex items-center gap-1.5 truncate text-xs text-neutral-500">
              <KommoLeadLink kommoLeadId={lead.kommo_lead_id} subdomain={kommoSubdomain} />
              <span>· canal:</span>
              {lead.channel ? (
                <>
                  <ChannelIcon channel={lead.channel} size={15} className="shrink-0" />
                  <span>{lead.channel}</span>
                </>
              ) : (
                <span>—</span>
              )}
            </p>
            {/* Etapa y estado del agente: se pinta YA con lo guardado en la base y
                se reemplaza con lo de Kommo cuando llega, sin frenar la conversación. */}
            <Suspense
              fallback={
                <StageAndStatus
                  maps={stageMaps}
                  stageId={lead.kommo_stage_id}
                  pipelineId={lead.kommo_pipeline_id}
                  agentCfg={agentCfg}
                />
              }
            >
              <LiveStageAndStatus lead={lead} maps={stageMaps} agentCfg={agentCfg} />
            </Suspense>
            <MoveStageMenu
              leadId={lead.id}
              pipelineId={lead.kommo_pipeline_id}
              stageId={lead.kommo_stage_id}
              pipelines={boardPipelines}
            />
          </div>
          {hasReviewPending && (
            <div className="shrink-0">
              <Badge color="amber">review pending</Badge>
            </div>
          )}
        </div>
      </header>

      {/* Lista de mensajes scrollable */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6">
          {messages.length === MAX_MESSAGES && (
            <p className="text-center text-[11px] text-neutral-400">Se muestran los últimos {MAX_MESSAGES} mensajes.</p>
          )}
          <Timeline messages={messages} stageEvents={stageEvents} draftsByMessage={draftsByMessage} maps={stageMaps} />
          <ScrollToBottom
            dep={`${lead.id}:${messages.length}:${messages[messages.length - 1]?.id ?? ""}:${draftsByMessage.size}`}
          />
        </div>
      </div>
    </>
  );
}

function NotFound() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <EmptyState
        icon={<MessageSquare size={20} />}
        title="Conversación no encontrada"
        description="El lead no existe o fue eliminado. Elegí otra conversación de la lista."
      />
    </div>
  );
}

function StageAndStatus({
  maps,
  stageId,
  pipelineId,
  agentCfg,
}: {
  maps: StageMaps;
  stageId: number | null;
  pipelineId: number | null;
  agentCfg: AgentStatusCfg;
}) {
  const agentStatus = computeAgentStatus({ ...agentCfg, stageId });
  const info = stageId != null ? resolveStage(maps, stageId, pipelineId) : undefined;
  return (
    <>
      {stageId != null && (
        <p
          className="mt-0.5 truncate text-xs text-neutral-500"
          title={info?.pipelineName ? `Pipeline: ${info.pipelineName}` : undefined}
        >
          <span
            className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700"
            style={info?.color ? { backgroundColor: info.color } : undefined}
          >
            📍 {info?.name ?? `#${stageId}`}
          </span>
          {info?.pipelineName && <span className="ml-1 text-neutral-400">{info.pipelineName}</span>}
        </p>
      )}
      <AgentStatusBadge status={agentStatus} />
    </>
  );
}

// Etapa EN VIVO desde Kommo (la verdad), dentro de un Suspense para que la
// conversación no la espere. SOLO LEE: renderizar la página no escribe en la base
// ni registra eventos. Si lo de Kommo difiere de lo guardado, monta un componente
// cliente que pide la escritura explícita (POST /api/leads/[id]/position) y
// refresca (la lista y el tablero quedan al día).
async function LiveStageAndStatus({
  lead,
  maps,
  agentCfg,
}: {
  lead: LeadRow;
  maps: StageMaps;
  agentCfg: AgentStatusCfg;
}) {
  let stageId = lead.kommo_stage_id;
  let pipelineId = lead.kommo_pipeline_id;
  let desfasada = false;
  if (lead.kommo_lead_id) {
    const live = await fetchLeadStage(lead.kommo_lead_id);
    if (live) {
      stageId = live.statusId;
      pipelineId = live.pipelineId ?? pipelineId;
      desfasada =
        live.statusId !== lead.kommo_stage_id ||
        (live.pipelineId != null && live.pipelineId !== lead.kommo_pipeline_id);
    }
  }
  return (
    <>
      {desfasada && <LivePositionSync leadId={lead.id} />}
      <StageAndStatus maps={maps} stageId={stageId} pipelineId={pipelineId} agentCfg={agentCfg} />
    </>
  );
}

function Timeline({
  messages,
  stageEvents,
  draftsByMessage,
  maps,
}: {
  messages: MessageRow[];
  stageEvents: StageEventRow[];
  draftsByMessage: Map<string, DraftRow>;
  maps: StageMaps;
}) {
  // Los eventos anteriores al primer mensaje mostrado quedan fuera: si la
  // conversación se recortó a los últimos MAX_MESSAGES, no se mezclan movimientos
  // de una parte que no se ve.
  const desde = messages.length === MAX_MESSAGES ? messages[0]?.created_at : null;
  type TimelineItem = { kind: "message"; item: MessageRow } | { kind: "stage"; item: StageEventRow };
  const timeline: TimelineItem[] = [
    ...messages.map((m): TimelineItem => ({ kind: "message", item: m })),
    ...stageEvents.filter((e) => !desde || e.created_at >= desde).map((e): TimelineItem => ({ kind: "stage", item: e })),
  ].sort((a, b) => +new Date(a.item.created_at) - +new Date(b.item.created_at));

  return (
    <>
      {timeline.map((entry) => {
        if (entry.kind === "stage") {
          const ev = entry.item;
          const isAgent = ev.moved_by === "agente";
          const fromName =
            ev.from_stage_name ??
            (ev.from_stage_id != null
              ? resolveStage(maps, ev.from_stage_id, ev.from_pipeline_id)?.name ?? `#${ev.from_stage_id}`
              : "—");
          const toInfo = resolveStage(maps, ev.to_stage_id, ev.pipeline_id);
          const toName = ev.to_stage_name ?? toInfo?.name ?? `#${ev.to_stage_id}`;
          const pipelineLabel = ev.pipeline_name ?? toInfo?.pipelineName ?? null;
          const label = isAgent
            ? "🤖 El agente movió:"
            : ev.actor_name
            ? `👤 Movido por ${ev.actor_name}:`
            : "👤 Movido en Kommo:";
          return (
            <div key={`stage-${ev.id}`} className="flex justify-center">
              <div
                className={
                  "inline-flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium shadow-sm " +
                  (isAgent
                    ? "border border-brand/20 bg-brand-soft text-brand-strong"
                    : "border border-neutral-200 bg-neutral-100 text-neutral-600")
                }
                title={pipelineLabel ? `Pipeline: ${pipelineLabel}` : undefined}
              >
                <span>{label}</span>
                <span className="font-semibold">{fromName}</span>
                <span>→</span>
                <span className="font-semibold">{toName}</span>
                <span className="ml-1 text-[10px] opacity-60">{timeAgo(ev.created_at)}</span>
              </div>
            </div>
          );
        }

        const m = entry.item;
        const cls = (m.classification ?? {}) as Record<string, unknown>;
        const draft = draftsByMessage.get(m.id);
        const isInbound = m.direction === "inbound";
        return (
          <div key={m.id} className="space-y-2">
            <div className={"flex " + (isInbound ? "justify-start" : "justify-end")}>
              <div
                className={
                  "max-w-[85%] rounded-2xl border px-4 py-3 shadow-sm " +
                  (isInbound
                    ? "rounded-tl-md border-neutral-200 bg-white"
                    : "rounded-tr-md border-brand/10 bg-brand-soft text-neutral-800")
                }
              >
                <div className="mb-1.5 flex flex-wrap items-center gap-1">
                  <Badge color={isInbound ? "neutral" : "blue"}>{isInbound ? "lead" : "agent"}</Badge>
                  {m.verticals?.slug && <Badge color="blue">{m.verticals.slug}</Badge>}
                  {m.is_comment && <Badge color="violet">comentario</Badge>}
                  {m.requires_human_review && <Badge color="amber">review</Badge>}
                  {Number(cls.urgency ?? 0) >= 4 && <Badge color="red">urg {String(cls.urgency)}</Badge>}
                  {Number(cls.toxicity ?? 0) > 0.3 && <Badge color="red">tox {Number(cls.toxicity).toFixed(1)}</Badge>}
                </div>
                {(() => {
                  // Anti-XSS: media_url viene del webhook público de Kommo —
                  // solo renderizamos http(s), jamás javascript:/data:.
                  const safeMediaUrl = m.media_url && /^https?:\/\//i.test(m.media_url) ? m.media_url : null;
                  return safeMediaUrl && m.media_kind === "image" ? (
                    <a href={safeMediaUrl} target="_blank" rel="noreferrer" className="block">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={safeMediaUrl}
                        alt="Imagen enviada por el lead"
                        loading="lazy"
                        className="mb-1.5 max-h-64 w-auto max-w-full rounded-lg border border-neutral-200 object-contain"
                      />
                    </a>
                  ) : safeMediaUrl ? (
                    <a
                      href={safeMediaUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mb-1.5 inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
                    >
                      📎 Abrir adjunto{m.media_kind === "audio" ? " de audio" : ""}
                    </a>
                  ) : null;
                })()}
                {/* Verificación del adjunto: si no se pudo leer, se dice acá mismo. Un
                    adjunto perdido es un lead perdido y antes solo quedaba como
                    "[Audio …]". */}
                {m.media_status === "failed" && (
                  <div className="mb-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
                    <p className="text-xs font-medium text-amber-800">⚠️ El agente no pudo leer este adjunto</p>
                    <p className="mt-0.5 text-[11px] text-amber-700">
                      No entró en la conversación — revisalo a mano en Kommo.
                      {m.media_error ? ` (${m.media_error})` : ""}
                    </p>
                  </div>
                )}
                {!(m.media_url && /^\[(Imagen|Documento|Audio|Archivo)/.test(m.content ?? "")) && (
                  <p className="whitespace-pre-wrap break-words text-sm text-neutral-900">{m.content}</p>
                )}
                <div className="mt-1.5 text-right text-[11px] text-neutral-400">{timeAgo(m.created_at)}</div>
                {cls.reasoning ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-neutral-400 hover:text-neutral-600">
                      ver clasificación
                    </summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-neutral-500">
                      {JSON.stringify(cls, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            </div>

            {/* Draft (agent response) si existe.
                generate-response inserta la fila VACÍA como lock (body:"",
                status:"pending", agent_metadata.generating) y la rellena ~30s
                después. Sin distinguir ese estado se veía una burbuja en blanco
                con el botón "Aprobar y enviar" activo: se podía aprobar una
                respuesta vacía. */}
            {draft && (() => {
              const draftBody = draftText(draft);
              const generating = draft.status === "pending" && draftBody.trim() === "";
              return (
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-md border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-sm">
                    <div className="mb-1.5 flex flex-wrap items-center gap-1">
                      <Badge color="green">draft</Badge>
                      {draft.edited_body && draft.edited_body.trim() && draft.edited_body.trim() !== draft.body.trim() && (
                        <Badge color="violet">editado</Badge>
                      )}
                      <Badge
                        color={
                          draft.status === "auto_sent" || draft.status === "sent"
                            ? "green"
                            : draft.status === "failed"
                            ? "red"
                            : draft.status === "rejected"
                            ? "neutral"
                            : "amber"
                        }
                      >
                        {draft.status === "auto_sent" ? "Respuesta automática" : generating ? "escribiendo…" : draft.status}
                      </Badge>
                    </div>
                    {generating ? (
                      <p className="flex items-center gap-2 text-sm italic text-neutral-500">
                        <span
                          aria-hidden
                          className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-emerald-300 border-t-emerald-600 motion-reduce:animate-none"
                        />
                        El agente está redactando la respuesta…
                      </p>
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-sm text-neutral-900">{draftBody}</p>
                    )}
                    <div className="mt-1.5 text-right text-[11px] text-neutral-400">
                      {draft.sent_at ? `enviado ${timeAgo(draft.sent_at)}` : timeAgo(draft.created_at)}
                    </div>
                    {typeof draft.agent_metadata?.public_reply === "string" && draft.agent_metadata.public_reply && (
                      <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-violet-500">
                          Respuesta pública (se publica en el comentario)
                        </p>
                        <p className="break-words text-xs text-violet-900">{String(draft.agent_metadata.public_reply)}</p>
                      </div>
                    )}
                    {/* Sin acciones mientras se redacta: no hay nada que aprobar todavía. */}
                    {!generating && (
                      <div className="mt-3 border-t border-emerald-200/70 pt-3">
                        <DraftActions draftId={draft.id} body={draftBody} status={draft.status} />
                      </div>
                    )}
                    {(draft.agent_metadata?.guard_blocked === true || draft.agent_metadata?.public_reply_blocked === true) && (
                      <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
                        ⚠️{" "}
                        {draft.agent_metadata.guard_part === "public_reply"
                          ? "La respuesta pública se bloqueó (el mensaje privado sí sale)"
                          : "El verificador bloqueó este mensaje: no se envía sin revisión"}
                        {typeof draft.agent_metadata.guard_reason === "string" ? ` — ${draft.agent_metadata.guard_reason}` : ""}.
                      </p>
                    )}
                    {typeof draft.agent_metadata?.publish_error === "string" && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-red-600">ver error de publicación</summary>
                        <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-red-700">
                          {String(draft.agent_metadata.publish_error)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              );
            })()}

            {isInbound && m.requires_human_review && !draft && !m.answered_by_draft_id && (
              <div className="flex justify-end">
                <div className="max-w-[85%]">
                  <ReviewActions messageId={m.id} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
