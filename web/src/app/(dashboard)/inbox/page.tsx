import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Badge, EmptyState, Inbox as InboxIcon, MessageSquare, Alert } from "@/components/ui";
import { timeAgo } from "@/lib/time-ago";
import RealtimeRefresher from "./realtime-refresher";
import DraftActions from "./draft-actions";
import ScrollToBottom from "./scroll-to-bottom";
import ReviewActions from "./review-actions";
import ChannelIcon from "./channel-icon";
import InboxFilters from "./filters";
import { fetchPipelines, fetchLeadStage } from "@/lib/kommo";
import { configValue } from "@/lib/runtime-config";
import { KommoLeadLink } from "./kommo-lead-link";
import { computeAgentStatus, AgentStatusBadge, type AgentStatus } from "./agent-status";

export const dynamic = "force-dynamic";

type SearchParams = {
  lead?: string;
  q?: string;
  channel?: string;
  vertical?: string;
  estado?: string;
  urgent?: string;
  rango?: string;
  sort?: string;
  etapa?: string;
};

// Pestaña de la lista según si el agente atiende la etapa del lead.
type EtapaTab = "agente" | "apagadas" | "todas";

function withinRange(iso: string | null, rango: string): boolean {
  if (!rango) return true;
  if (!iso) return false;
  const age = Date.now() - new Date(iso).getTime();
  const H = 3600_000;
  const D = 24 * H;
  if (rango === "1h") return age <= H;
  if (rango === "today") return age <= D;
  if (rango === "7d") return age <= 7 * D;
  if (rango === "30d") return age <= 30 * D;
  return true;
}

function normChannel(ch: string | null): string {
  if (!ch) return "other";
  const c = ch.toLowerCase();
  if (c.includes("whatsapp") || c === "waba") return "whatsapp";
  if (c.includes("instagram")) return "instagram";
  if (c.includes("facebook") || c === "fb") return "facebook";
  if (c.includes("tiktok")) return "tiktok";
  if (c.includes("telegram")) return "telegram";
  return "other";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Métrica compacta para el topbar del Inbox: una píldora en línea en vez de la
// card grande de StatCard, que en un layout split ocupaba demasiado alto.
function MiniStat({
  icon,
  label,
  value,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "default" | "brand" | "amber" | "red";
}) {
  const tones = {
    default: "bg-neutral-100 text-neutral-600",
    brand: "bg-brand-soft text-brand-strong",
    amber: "bg-amber-50 text-amber-700",
    red: "bg-red-50 text-red-700",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${tones[tone]}`}
    >
      <span aria-hidden className="shrink-0 opacity-70">
        {icon}
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="hidden opacity-80 sm:inline">{label}</span>
    </span>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const supabase = createSupabaseServerClient();
  const selectedLead = searchParams.lead ?? null;

  // 1) Leads activos (con al menos un mensaje, ordenados por último mensaje) +
  // las etapas apagadas, que se usan para separar la lista entre las
  // conversaciones que el agente atiende y las que ignora por etapa.
  const [{ data: leads }, { data: stageCfg }] = await Promise.all([
    supabase
      .from("leads")
      .select(
        "id, display_name, channel, kommo_lead_id, kommo_stage_id, last_message_at, messages!inner(id, content, direction, requires_human_review, created_at, classification, verticals(slug))"
      )
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(500),
    supabase
      .from("kommo_publish_config")
      .select("ignored_stage_ids")
      .eq("is_active", true)
      .maybeSingle(),
  ]);

  const ignoredStages = new Set(
    (((stageCfg?.ignored_stage_ids ?? []) as unknown[]).map(Number)).filter(Number.isFinite)
  );
  // Etapa desconocida (todavía sin sincronizar desde Kommo) = el agente SÍ
  // responde: el gate de process-inbound es fail-open. La lista refleja el
  // comportamiento real, no el deseado.
  const agentHandles = (stageId: number | null) =>
    stageId == null || !ignoredStages.has(Number(stageId));

  // Trabajamos lead-by-lead: para cada uno sacamos el último mensaje y flag de review
  type LeadRow = {
    id: string;
    display_name: string | null;
    channel: string | null;
    kommo_lead_id: number | null;
    kommo_stage_id: number | null;
    last_message_at: string | null;
    lastMsg: { content: string; direction: string; vertical: string | null; requires_review: boolean; created_at: string } | null;
    hasReviewPending: boolean;
    verticals: string[];
    maxUrgency: number;
    maxToxicity: number;
    msgCount: number;
  };

  const allLeadRows: LeadRow[] = (leads ?? []).map((l) => {
    const msgs = ((l as unknown as { messages?: Array<{
      content: string;
      direction: string;
      requires_human_review: boolean;
      created_at: string;
      classification: Record<string, unknown> | null;
      verticals: { slug: string } | null;
    }> }).messages ?? []);
    const sorted = msgs.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    const last = sorted[0] ?? null;
    const verticals = Array.from(
      new Set(msgs.map((m) => m.verticals?.slug).filter(Boolean) as string[])
    );
    let maxUrgency = 0;
    let maxToxicity = 0;
    for (const m of msgs) {
      const cls = (m.classification ?? {}) as Record<string, unknown>;
      maxUrgency = Math.max(maxUrgency, Number(cls.urgency ?? 0) || 0);
      maxToxicity = Math.max(maxToxicity, Number(cls.toxicity ?? 0) || 0);
    }
    return {
      id: l.id,
      display_name: l.display_name,
      channel: l.channel,
      kommo_lead_id: l.kommo_lead_id,
      kommo_stage_id: (l as unknown as { kommo_stage_id?: number | null }).kommo_stage_id ?? null,
      last_message_at: l.last_message_at,
      lastMsg: last
        ? {
            content: last.content,
            direction: last.direction,
            vertical: last.verticals?.slug ?? null,
            requires_review: last.requires_human_review,
            created_at: last.created_at,
          }
        : null,
      hasReviewPending: sorted.some((m) => m.direction === "inbound" && m.requires_human_review),
      verticals,
      maxUrgency,
      maxToxicity,
      msgCount: msgs.length,
    };
  });

  // Opciones disponibles (derivadas de los datos cargados)
  const channelOptions = Array.from(
    new Set(allLeadRows.map((l) => normChannel(l.channel)))
  ).sort();
  const verticalOptions = Array.from(
    new Set(allLeadRows.flatMap((l) => l.verticals))
  ).sort();

  // Filtros activos
  const fQ = (searchParams.q ?? "").trim().toLowerCase();
  const fChannel = searchParams.channel ?? "";
  const fVertical = searchParams.vertical ?? "";
  const fEstado = searchParams.estado ?? "";
  const fUrgent = searchParams.urgent === "1";
  const fRango = searchParams.rango ?? "";
  const fSort = searchParams.sort ?? "recent";
  // Pestaña de etapa. Por defecto "agente": la mayoría de los embudos están
  // apagados y esas conversaciones son ruido para quien opera el agente.
  const fEtapa: EtapaTab =
    searchParams.etapa === "apagadas"
      ? "apagadas"
      : searchParams.etapa === "todas"
        ? "todas"
        : "agente";

  // Conteos por pestaña: se calculan ANTES de aplicar el filtro de etapa, pero
  // DESPUÉS del resto, para que los números sigan a lo que se está mirando.
  const matchesOtherFilters = (l: (typeof allLeadRows)[number]) => {
    if (fQ) {
      const hay = `${l.display_name ?? ""} ${l.kommo_lead_id ?? ""} ${l.lastMsg?.content ?? ""}`.toLowerCase();
      if (!hay.includes(fQ)) return false;
    }
    if (fChannel && normChannel(l.channel) !== fChannel) return false;
    if (fVertical && !l.verticals.includes(fVertical)) return false;
    if (fUrgent && l.maxUrgency < 4) return false;
    if (fEstado === "review" && !l.hasReviewPending) return false;
    if (fEstado === "waiting" && l.lastMsg?.direction !== "inbound") return false;
    if (fEstado === "answered" && l.lastMsg?.direction !== "outbound") return false;
    if (fEstado === "toxic" && l.maxToxicity <= 0.3) return false;
    if (fRango && !withinRange(l.last_message_at, fRango)) return false;
    return true;
  };
  const preEtapa = allLeadRows.filter(matchesOtherFilters);
  const etapaCounts = {
    agente: preEtapa.filter((l) => agentHandles(l.kommo_stage_id)).length,
    apagadas: preEtapa.filter((l) => !agentHandles(l.kommo_stage_id)).length,
    todas: preEtapa.length,
  };

  const leadRows = allLeadRows
    .filter((l) => {
      if (fEtapa === "agente" && !agentHandles(l.kommo_stage_id)) return false;
      if (fEtapa === "apagadas" && agentHandles(l.kommo_stage_id)) return false;
      if (fQ) {
        const hay = `${l.display_name ?? ""} ${l.kommo_lead_id ?? ""} ${l.lastMsg?.content ?? ""}`.toLowerCase();
        if (!hay.includes(fQ)) return false;
      }
      if (fChannel && normChannel(l.channel) !== fChannel) return false;
      if (fVertical && !l.verticals.includes(fVertical)) return false;
      if (fUrgent && l.maxUrgency < 4) return false;
      if (fEstado === "review" && !l.hasReviewPending) return false;
      if (fEstado === "waiting" && l.lastMsg?.direction !== "inbound") return false;
      if (fEstado === "answered" && l.lastMsg?.direction !== "outbound") return false;
      if (fEstado === "toxic" && l.maxToxicity <= 0.3) return false;
      if (fRango && !withinRange(l.last_message_at, fRango)) return false;
      return true;
    })
    .sort((a, b) => {
      const ta = a.last_message_at ? +new Date(a.last_message_at) : 0;
      const tb = b.last_message_at ? +new Date(b.last_message_at) : 0;
      if (fSort === "oldest") return ta - tb;
      if (fSort === "urgency")
        return b.maxUrgency - a.maxUrgency || tb - ta;
      if (fSort === "messages") return b.msgCount - a.msgCount || tb - ta;
      return tb - ta; // recent (default)
    });

  const hasActiveFilters =
    !!fQ ||
    !!fChannel ||
    !!fVertical ||
    !!fEstado ||
    fUrgent ||
    !!fRango ||
    fSort !== "recent";

  // Querystring de filtros (sin lead) para preservarlos al elegir conversación
  const filterParams = new URLSearchParams();
  if (fQ) filterParams.set("q", searchParams.q!.trim());
  if (fChannel) filterParams.set("channel", fChannel);
  if (fVertical) filterParams.set("vertical", fVertical);
  if (fEstado) filterParams.set("estado", fEstado);
  if (fUrgent) filterParams.set("urgent", "1");
  if (fRango) filterParams.set("rango", fRango);
  if (fSort !== "recent") filterParams.set("sort", fSort);
  if (fEtapa !== "agente") filterParams.set("etapa", fEtapa);
  const filterQS = filterParams.toString();

  // Href de cada pestaña: conserva el resto de filtros y suelta el lead abierto
  // (puede no existir en la pestaña destino).
  const etapaHref = (tab: EtapaTab) => {
    const qs = new URLSearchParams(filterParams);
    if (tab === "agente") qs.delete("etapa");
    else qs.set("etapa", tab);
    const s = qs.toString();
    return s ? `/inbox?${s}` : "/inbox";
  };

  // 2) Conversación seleccionada
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
    to_stage_id: number;
    from_stage_name: string | null;
    to_stage_name: string | null;
    pipeline_name: string | null;
    moved_by: "agente" | "kommo";
    created_at: string;
  };

  let lead: LeadRow | null = null;
  let messages: MessageRow[] = [];
  const draftsByMessage = new Map<string, DraftRow>();
  let stageEvents: StageEventRow[] = [];
  // Etapa actual del lead seleccionado: en vivo desde Kommo (la verdad), con
  // fallback al kommo_stage_id persistido (los webhooks de mensajes no traen
  // etapa, así que la columna suele estar vacía hasta el primer movimiento).
  let currentStageId: number | null = null;
  let kommoSubdomain: string | null = null;
  // Estado del agente para ESTA conversación (por qué responde o no).
  let agentStatus: AgentStatus | null = null;
  // Map stageId → { name, pipelineName } for resolving stage names in UI
  const stageMap = new Map<number, { name: string; pipelineName: string }>();

  if (selectedLead) {
    lead = allLeadRows.find((l) => l.id === selectedLead) ?? null;
    const { data: msgs } = await supabase
      .from("messages")
      .select(
        "id, direction, content, source, kommo_message_id, requires_human_review, answered_by_draft_id, classification, created_at, media_url, media_kind, media_status, media_error, is_comment, verticals(slug)"
      )
      .eq("lead_id", selectedLead)
      .order("created_at", { ascending: true })
      .limit(100);
    // Supabase tipa joins anidados como array; aplanamos a single
    messages = ((msgs ?? []) as unknown as Array<MessageRow & { verticals: { slug: string }[] | { slug: string } | null }>).map(
      (m) => ({
        ...m,
        is_comment: (m as unknown as { is_comment?: boolean }).is_comment === true,
        verticals: Array.isArray(m.verticals) ? m.verticals[0] ?? null : m.verticals,
      })
    );

    const msgIds = messages.map((m) => m.id);
    if (msgIds.length > 0) {
      const { data: drafts } = await supabase
        .from("drafts")
        .select("id, message_id, body, edited_body, status, agent_metadata, sent_at, created_at")
        .in("message_id", msgIds);
      for (const d of (drafts ?? []) as unknown as DraftRow[]) draftsByMessage.set(d.message_id, d);
    }

    // Traer eventos de cambio de etapa del lead seleccionado
    const { data: evts } = await supabase
      .from("lead_stage_events")
      .select("id, from_stage_id, to_stage_id, from_stage_name, to_stage_name, pipeline_name, moved_by, created_at")
      .eq("lead_id", selectedLead)
      .order("created_at", { ascending: true });
    stageEvents = (evts ?? []) as StageEventRow[];

    // Cargar mapa de etapas desde Kommo para resolución de nombres (fail-open)
    try {
      const { configured, pipelines } = await fetchPipelines();
      if (configured) {
        for (const p of pipelines) {
          for (const s of p.statuses) {
            stageMap.set(s.id, { name: s.name, pipelineName: p.name });
          }
        }
      }
    } catch {
      // fail-open: sin mapa de stages, mostramos IDs
    }

    // Subdominio de Kommo para el link directo a la ficha del lead.
    kommoSubdomain = (await configValue("KOMMO_SUBDOMAIN")) || null;

    // Etapa actual en vivo + persistencia oportunista del valor fresco.
    const { data: leadRow } = await supabase
      .from("leads")
      .select("kommo_lead_id, kommo_stage_id")
      .eq("id", selectedLead)
      .maybeSingle();
    currentStageId = leadRow?.kommo_stage_id ?? null;
    if (leadRow?.kommo_lead_id) {
      const live = await fetchLeadStage(leadRow.kommo_lead_id);
      if (live) {
        currentStageId = live.statusId;
        if (live.statusId !== leadRow.kommo_stage_id) {
          await supabase
            .from("leads")
            .update({ kommo_stage_id: live.statusId })
            .eq("id", selectedLead);
        }
      }
    }

    // Estado del agente para esta conversación: mismos gates que el backend.
    const { data: pubCfg } = await supabase
      .from("kommo_publish_config")
      .select("agent_enabled, publishing_enabled, salesbot_id, ignored_stage_ids")
      .eq("is_active", true)
      .maybeSingle();
    agentStatus = computeAgentStatus({
      // generate-response solo bloquea con agent_enabled === false explícito.
      agentEnabled: pubCfg?.agent_enabled !== false,
      publishingEnabled: pubCfg?.publishing_enabled === true,
      salesbotId: (pubCfg?.salesbot_id as number | null) ?? null,
      ignoredStageIds: (((pubCfg?.ignored_stage_ids ?? []) as unknown[])
        .map(Number)
        .filter((n) => Number.isFinite(n))),
      stageId: currentStageId,
    });
  }

  // 3) Counters de header
  const pendingReview = allLeadRows.filter((l) => l.hasReviewPending).length;
  const totalActive = allLeadRows.length;
  const shownCount = leadRows.length;
  // Las tres métricas del topbar miden SIEMPRE el inbox completo, para que no
  // cambien al saltar de pestaña. Lo que se está viendo lo dicen los contadores
  // de las propias pestañas.
  const sinResponder = allLeadRows.filter((l) => l.lastMsg?.direction === "inbound").length;

  const leadName = lead ? (lead.display_name ?? `Lead ${lead.kommo_lead_id ?? "?"}`) : "";

  return (
    <div className="flex h-full flex-col bg-neutral-50">
      <RealtimeRefresher />

      {/* Topbar sticky manual (Inbox es split-full-height — NO usa PageShell).
          Las métricas van EN LÍNEA con el título: en un split a pantalla
          completa, tres cards apiladas se comían el alto útil de la lista. */}
      <div className="sticky top-0 z-20 border-b border-neutral-200/80 bg-white/80 backdrop-blur-md">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
          <h1 className="text-[15px] font-semibold tracking-tight text-neutral-900">Inbox</h1>
          <div className="flex items-center gap-1.5">
            <MiniStat
              icon={<InboxIcon size={14} />}
              label="conversaciones"
              value={totalActive}
              tone="brand"
            />
            <MiniStat
              icon={<MessageSquare size={14} />}
              label="sin responder"
              value={sinResponder}
              tone={sinResponder > 0 ? "amber" : "default"}
            />
            <MiniStat
              icon={<Alert size={14} />}
              label="en revisión"
              value={pendingReview}
              tone={pendingReview > 0 ? "red" : "default"}
            />
          </div>
        </div>
      </div>

      {/* Barra de filtros full-width: todos los filtros en una línea a lo ancho.
          En móvil se oculta cuando hay una conversación abierta (foco en el chat). */}
      <div
        className={
          "border-b border-neutral-200/80 bg-white px-4 py-2.5 sm:px-6 " +
          (selectedLead ? "hidden lg:block" : "block")
        }
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <InboxFilters
              channels={channelOptions}
              verticals={verticalOptions}
              inline
            />
          </div>
          {hasActiveFilters && (
            <p className="shrink-0 text-xs text-neutral-500">
              <span className="font-medium text-neutral-700">{shownCount}</span> de {totalActive}
            </p>
          )}
        </div>
      </div>

      {/* Contenido split: lista + conversación */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar de leads — siempre en desktop; en móvil sólo si NO hay lead */}
        <aside
          className={
            "flex-col border-r border-neutral-200 bg-white lg:flex lg:w-96 " +
            (selectedLead ? "hidden w-full" : "flex w-full")
          }
        >
          {/* Pestañas por etapa: separa lo que el agente atiende de lo que
              ignora por estar en un embudo apagado. Sin esto, las
              conversaciones de venta por zona y de equipo interno —donde el
              agente no debe responder— tapaban a las que sí importan. */}
          <div className="flex shrink-0 gap-1 border-b border-neutral-200 px-2 py-2">
            {([
              { id: "agente", label: "Con agente" },
              { id: "apagadas", label: "Apagadas" },
              { id: "todas", label: "Todas" },
            ] as const).map((t) => {
              const on = fEtapa === t.id;
              return (
                <Link
                  key={t.id}
                  href={etapaHref(t.id)}
                  aria-current={on ? "page" : undefined}
                  className={
                    "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors " +
                    (on
                      ? "bg-brand-soft text-brand-strong"
                      : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900")
                  }
                >
                  {t.label}
                  <span
                    className={
                      "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums " +
                      (on ? "bg-white/70 text-brand-strong" : "bg-neutral-100 text-neutral-500")
                    }
                  >
                    {etapaCounts[t.id]}
                  </span>
                </Link>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto">
            {leadRows.length === 0 ? (
              <p className="p-5 text-sm text-neutral-500">
                {fEtapa === "agente"
                  ? "Ninguna conversación en etapas donde el agente responde."
                  : fEtapa === "apagadas"
                    ? "Ninguna conversación en etapas apagadas."
                    : "Sin conversaciones todavía."}
              </p>
            ) : (
              <ul className="divide-y divide-neutral-100">
                {leadRows.map((l) => {
                  const name = l.display_name ?? `Lead ${l.kommo_lead_id ?? "?"}`;
                  const active = selectedLead === l.id;
                  return (
                    <li key={l.id}>
                      <Link
                        href={`/inbox?lead=${l.id}${filterQS ? `&${filterQS}` : ""}`}
                        className={
                          "block px-3 py-2 transition-colors " +
                          (active ? "bg-brand-soft" : "hover:bg-neutral-50")
                        }
                      >
                        <div className="flex items-center gap-2.5">
                          <div className={
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold " +
                            (active ? "bg-brand text-brand-foreground" : "bg-neutral-100 text-neutral-600")
                          }>
                            {initials(name)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <p className={
                                "truncate text-[13px] font-medium leading-tight " +
                                (active ? "text-brand-strong" : "text-neutral-900")
                              }>
                                {name}
                              </p>
                              <span className="shrink-0 text-[10px] text-neutral-400">
                                {l.last_message_at ? timeAgo(l.last_message_at) : "—"}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              {l.channel && (
                                <ChannelIcon channel={l.channel} size={13} className="shrink-0" />
                              )}
                              {l.lastMsg && (
                                <p className="min-w-0 flex-1 truncate text-[11px] leading-tight text-neutral-500">
                                  {l.lastMsg.direction === "outbound" ? "→ " : ""}
                                  {l.lastMsg.content}
                                </p>
                              )}
                              {l.lastMsg?.vertical && <Badge color="blue" size="sm">{l.lastMsg.vertical}</Badge>}
                              {l.hasReviewPending && <Badge color="amber" size="sm">revisión</Badge>}
                            </div>
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* Conversación — siempre en desktop; en móvil sólo si HAY lead */}
        <section
          className={
            "min-w-0 flex-1 flex-col bg-neutral-50 lg:flex " +
            (selectedLead ? "flex" : "hidden lg:flex")
          }
        >
          {lead ? (
            <>
              {/* Header sticky de la conversación */}
              <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white px-5 py-3">
                <div className="flex items-center gap-3">
                  <Link
                    href={filterQS ? `/inbox?${filterQS}` : "/inbox"}
                    className="-ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 lg:hidden"
                  >
                    ← Volver
                  </Link>
                  <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[11px] font-semibold text-neutral-600 lg:flex">
                    {initials(leadName)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold tracking-tight text-neutral-900">
                      {leadName}
                    </p>
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
                    {currentStageId != null && (() => {
                      const stageInfo = stageMap.get(currentStageId);
                      const stageName = stageInfo?.name ?? `#${currentStageId}`;
                      const pipelineName = stageInfo?.pipelineName;
                      return (
                        <p
                          className="mt-0.5 truncate text-xs text-neutral-500"
                          title={pipelineName ? `Pipeline: ${pipelineName}` : undefined}
                        >
                          <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                            📍 {stageName}
                          </span>
                          {pipelineName && (
                            <span className="ml-1 text-neutral-400">{pipelineName}</span>
                          )}
                        </p>
                      );
                    })()}
                    {agentStatus && <AgentStatusBadge status={agentStatus} />}
                  </div>
                  {lead.hasReviewPending && (
                    <div className="shrink-0"><Badge color="amber">review pending</Badge></div>
                  )}
                </div>
              </header>

              {/* Lista de mensajes scrollable */}
              <div className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6">
                  {(() => {
                    // Construir timeline unificada: mensajes + eventos de etapa ordenados por created_at
                    type TimelineItem =
                      | { kind: "message"; item: MessageRow }
                      | { kind: "stage"; item: StageEventRow };

                    const timeline: TimelineItem[] = [
                      ...messages.map((m): TimelineItem => ({ kind: "message", item: m })),
                      ...stageEvents.map((e): TimelineItem => ({ kind: "stage", item: e })),
                    ].sort((a, b) => +new Date(a.item.created_at) - +new Date(b.item.created_at));

                    return timeline.map((entry) => {
                      if (entry.kind === "stage") {
                        const ev = entry.item;
                        const isAgent = ev.moved_by === "agente";
                        const fromName = ev.from_stage_name ?? (ev.from_stage_id != null ? stageMap.get(ev.from_stage_id)?.name ?? `#${ev.from_stage_id}` : "—");
                        const toName = ev.to_stage_name ?? stageMap.get(ev.to_stage_id)?.name ?? `#${ev.to_stage_id}`;
                        const pipelineLabel = ev.pipeline_name ?? stageMap.get(ev.to_stage_id)?.pipelineName ?? null;
                        return (
                          <div key={`stage-${ev.id}`} className="flex justify-center">
                            <div
                              className={
                                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium shadow-sm " +
                                (isAgent
                                  ? "bg-brand-soft text-brand-strong border border-brand/20"
                                  : "bg-neutral-100 text-neutral-600 border border-neutral-200")
                              }
                              title={pipelineLabel ? `Pipeline: ${pipelineLabel}` : undefined}
                            >
                              <span>{isAgent ? "🤖 El agente movió:" : "👤 Movido en Kommo:"}</span>
                              <span className="font-semibold">{fromName}</span>
                              <span>→</span>
                              <span className="font-semibold">{toName}</span>
                              <span className="text-[10px] opacity-60 ml-1">{timeAgo(ev.created_at)}</span>
                            </div>
                          </div>
                        );
                      }

                      // entry.kind === "message"
                      const m = entry.item;
                      const cls = (m.classification ?? {}) as Record<string, unknown>;
                      const draft = draftsByMessage.get(m.id);
                      const isInbound = m.direction === "inbound";
                      return (
                        <div key={m.id} className="space-y-2">
                          <div
                            className={
                              "flex " + (isInbound ? "justify-start" : "justify-end")
                            }
                          >
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
                                const safeMediaUrl =
                                  m.media_url && /^https?:\/\//i.test(m.media_url) ? m.media_url : null;
                                return safeMediaUrl && m.media_kind === "image" ? (
                                <a href={safeMediaUrl} target="_blank" rel="noreferrer" className="block">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={safeMediaUrl}
                                    alt="Imagen enviada por el lead"
                                    loading="lazy"
                                    className="mb-1.5 max-h-64 rounded-lg border border-neutral-200 object-contain"
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
                              {/* Verificación del adjunto: si no se pudo leer, se
                                  dice acá mismo. Un adjunto perdido es un lead
                                  perdido y antes solo quedaba como "[Audio …]". */}
                              {m.media_status === "failed" && (
                                <div className="mb-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
                                  <p className="text-xs font-medium text-amber-800">
                                    ⚠️ El agente no pudo leer este adjunto
                                  </p>
                                  <p className="mt-0.5 text-[11px] text-amber-700">
                                    No entró en la conversación — revisalo a mano en Kommo.
                                    {m.media_error ? ` (${m.media_error})` : ""}
                                  </p>
                                </div>
                              )}
                              {!(m.media_url && /^\[(Imagen|Documento|Audio|Archivo)/.test(m.content ?? "")) && (
                                <p className="whitespace-pre-wrap text-sm text-neutral-900">{m.content}</p>
                              )}
                              <div className="mt-1.5 text-right text-[11px] text-neutral-400">
                                {timeAgo(m.created_at)}
                              </div>
                              {cls.reasoning ? (
                                <details className="mt-2">
                                  <summary className="cursor-pointer text-xs text-neutral-400 hover:text-neutral-600">
                                    ver clasificación
                                  </summary>
                                  <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-neutral-500">
                                    {JSON.stringify(cls, null, 2)}
                                  </pre>
                                </details>
                              ) : null}
                            </div>
                          </div>

                          {/* Draft (agent response) si existe.
                              generate-response inserta la fila VACÍA como lock
                              (body:"", status:"pending", agent_metadata.generating)
                              y la rellena ~30s después. Sin distinguir ese estado
                              se veía una burbuja en blanco con el botón "Aprobar y
                              enviar" activo — se podía aprobar una respuesta vacía. */}
                          {draft && (() => {
                            const draftBody = draft.edited_body ?? draft.body ?? "";
                            const generating =
                              draft.status === "pending" && draftBody.trim() === "";
                            return (
                            <div className="flex justify-end">
                              <div className="max-w-[85%] rounded-2xl rounded-tr-md border border-emerald-200 bg-emerald-50 px-4 py-3 shadow-sm">
                                <div className="mb-1.5 flex flex-wrap items-center gap-1">
                                  <Badge color="green">draft</Badge>
                                  <Badge color={
                                    draft.status === "auto_sent" || draft.status === "sent"
                                      ? "green"
                                      : draft.status === "failed"
                                      ? "red"
                                      : draft.status === "rejected"
                                      ? "neutral"
                                      : "amber"
                                  }>
                                    {draft.status === "auto_sent"
                                      ? "Respuesta automática"
                                      : generating
                                      ? "escribiendo…"
                                      : draft.status}
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
                                  <p className="whitespace-pre-wrap text-sm text-neutral-900">
                                    {draftBody}
                                  </p>
                                )}
                                <div className="mt-1.5 text-right text-[11px] text-neutral-400">
                                  {draft.sent_at ? `enviado ${timeAgo(draft.sent_at)}` : timeAgo(draft.created_at)}
                                </div>
                                {typeof draft.agent_metadata?.public_reply === "string" &&
                                  draft.agent_metadata.public_reply && (
                                    <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
                                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-violet-500">
                                        Respuesta pública (se publica en el comentario)
                                      </p>
                                      <p className="text-xs text-violet-900">
                                        {String(draft.agent_metadata.public_reply)}
                                      </p>
                                    </div>
                                  )}
                                {/* Sin acciones mientras se redacta: no hay nada
                                    que aprobar todavía. */}
                                {!generating && (
                                  <div className="mt-3 border-t border-emerald-200/70 pt-3">
                                    <DraftActions
                                      draftId={draft.id}
                                      body={draftBody}
                                      status={draft.status}
                                    />
                                  </div>
                                )}
                                {typeof draft.agent_metadata?.publish_error === "string" && (
                                  <details className="mt-2">
                                    <summary className="cursor-pointer text-xs text-red-600">
                                      ver error de publicación
                                    </summary>
                                    <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-red-700">
                                      {String(draft.agent_metadata.publish_error)}
                                    </pre>
                                  </details>
                                )}
                              </div>
                            </div>
                            );
                          })()}

                          {isInbound &&
                            m.requires_human_review &&
                            !draft &&
                            !m.answered_by_draft_id && (
                              <div className="flex justify-end">
                                <div className="max-w-[85%]">
                                  <ReviewActions messageId={m.id} />
                                </div>
                              </div>
                            )}
                        </div>
                      );
                    });
                  })()}
                  <ScrollToBottom
                    dep={`${selectedLead}:${messages.length}:${messages[messages.length - 1]?.id ?? ""}:${draftsByMessage.size}`}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <EmptyState
                icon={<MessageSquare size={20} />}
                title="Seleccioná un lead"
                description="Elegí una conversación de la lista para verla acá."
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
