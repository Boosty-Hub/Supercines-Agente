"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Alert, Badge, Inbox as InboxIcon, LazyReveal, MessageSquare } from "@/components/ui";
import { timeAgo } from "@/lib/time-ago";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  initials,
  INBOX_URL_PARAMS,
  normChannel,
  withinRange,
  type InboxListData,
  type LeadSummary,
} from "@/lib/inbox-data";
import ChannelIcon from "./channel-icon";
import InboxFilters from "./filters";
import { computeAgentStatus, AgentStatusDot } from "./agent-status";
import { leadMoves } from "@/lib/move-client";
import Board, { NO_EXISTE, pipelineCounts, SIN_UBICAR } from "./board";

// La lista/tablero del inbox vive en el LAYOUT (este componente) y la
// conversación en /inbox/[leadId]. Next no vuelve a renderizar un layout al
// navegar entre sus hijos, así que abrir otra conversación ya no recalcula la
// lista: antes cada clic re-renderizaba la página entera con todos los mensajes.
//
// Los datos se piden al montar a /api/inbox/leads, y NO los pasa el server
// component: un router.refresh() (el refresco en vivo de la conversación)
// re-renderiza también el layout, y con la lista del lado del servidor cada
// mensaje nuevo en la conversación abierta la volvería a calcular entera.

// Cambios de CUALQUIER lead → se agrupan en una sola recarga de la lista. Con
// leads.status/update ahora accionables (y el backfill) pueden llegar ráfagas:
// una recarga cada 5 s como máximo, sin importar cuántos eventos entren.
const LISTA_MS = 5000;


type Aviso = { tone: "error" | "ok" | "info"; text: string };

// Pestaña de la VISTA LISTA según si el agente atiende la etapa del lead. La
// mayoría de los embudos de SuperCines están apagados (ventas por zona, equipo
// interno) y esas conversaciones tapaban a las que sí importan. El tablero NO
// la aplica: es el espejo completo de Kommo y cada tarjeta ya marca con un punto
// si el agente está apagado en su etapa.
type EtapaTab = "agente" | "apagadas" | "todas";
const ETAPA_TABS: ReadonlyArray<{ id: EtapaTab; label: string }> = [
  { id: "agente", label: "Con agente" },
  { id: "apagadas", label: "Apagadas" },
  { id: "todas", label: "Todas" },
];

// Métrica compacta del topbar: una píldora en línea (la card grande de StatCard
// ocupaba demasiado alto en un layout a pantalla completa).
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
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${tones[tone]}`}>
      <span aria-hidden className="shrink-0 opacity-70">
        {icon}
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="hidden opacity-80 sm:inline">{label}</span>
    </span>
  );
}

export default function InboxShell({ children }: { children: React.ReactNode }) {
  const params = useParams<{ leadId?: string }>();
  const selectedLead = params?.leadId ?? null;
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Vista y pipeline viven en la URL (se pueden compartir y sobreviven al
  // refresco) y se cambian sin navegar: todo se calcula en el cliente.
  const vista = sp.get("vista") === "lista" ? "lista" : "tablero";
  const setParam = (key: string, value: string | null) => {
    const p = new URLSearchParams(sp.toString());
    if (value) p.set(key, value);
    else p.delete(key);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  };

  // En móvil los filtros ocupaban media pantalla: van plegados detrás de un
  // botón. Arranca en false (igual que el HTML del servidor) y se ajusta al montar.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const [data, setData] = useState<InboxListData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cargando = useRef(false);
  const pendiente = useRef(false);
  // Destino pedido por lead mientras su movimiento sigue en la cola (lib/move-queue.ts):
  // una recarga que llega en el medio trae la etapa vieja y se pisa con esto.
  const pendingMoves = useRef(new Map<string, { pipeline: number; stage: number }>());

  const load = useCallback(async () => {
    // Una recarga a la vez; si llega otro aviso en el medio, se hace una más al
    // terminar (no se pierde el último cambio, y no se apilan 10 pedidos).
    if (cargando.current) {
      pendiente.current = true;
      return;
    }
    cargando.current = true;
    try {
      const res = await fetch("/api/inbox/leads", { cache: "no-store" });
      // Sesión vencida: el middleware redirige a /login y llega HTML, no JSON.
      if (res.redirected || !(res.headers.get("content-type") ?? "").includes("json")) {
        window.location.href = "/login";
        return;
      }
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const fresh = json as InboxListData;
      // Una recarga que llega con un movimiento en curso trae la etapa VIEJA:
      // se respeta la del movimiento para que la tarjeta no salte hacia atrás.
      if (pendingMoves.current.size > 0) {
        fresh.leads = fresh.leads.map((l) => {
          const m = pendingMoves.current.get(l.id);
          return m ? { ...l, kommo_pipeline_id: m.pipeline, kommo_stage_id: m.stage } : l;
        });
      }
      setData(fresh);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      cargando.current = false;
      if (pendiente.current) {
        pendiente.current = false;
        void load();
      }
    }
  }, []);

  useEffect(() => {
    void load();
    // "Mover a…" de la conversación avisa por acá para que el tablero no espere
    // al refresco en vivo (5 s) para mover la tarjeta.
    const onReload = () => void load();
    window.addEventListener("inbox:reload", onReload);
    return () => window.removeEventListener("inbox:reload", onReload);
  }, [load]);

  const [aviso, setAviso] = useState<Aviso | null>(null);
  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(null), aviso.tone === "error" ? 8000 : aviso.tone === "info" ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [aviso]);

  // ── Mover de etapa ───────────────────────────────────────────────────────
  // Optimista: la tarjeta cambia de columna al soltarla y, si Kommo falla,
  // vuelve a donde estaba con el motivo en un aviso.
  const [movingIds, setMovingIds] = useState<Set<string>>(() => new Set());
  const moveLead = useCallback(
    async (leadId: string, toPipeline: number, toStage: number) => {
      const before = data?.leads.find((l) => l.id === leadId);
      if (!before) return;
      const patch = (pipeline: number | null, stage: number | null) =>
        setData((d) =>
          d
            ? {
                ...d,
                leads: d.leads.map((l) =>
                  l.id === leadId ? { ...l, kommo_pipeline_id: pipeline, kommo_stage_id: stage } : l
                ),
              }
            : d
        );
      patch(toPipeline, toStage);
      pendingMoves.current.set(leadId, { pipeline: toPipeline, stage: toStage });
      setMovingIds((s) => new Set(s).add(leadId));
      const stageName =
        data?.pipelines.find((p) => p.id === toPipeline)?.stages.find((s) => s.id === toStage)?.name ?? `#${toStage}`;
      const nombre = before.display_name ?? `Lead ${before.kommo_lead_id ?? ""}`;
      // Cola por lead (lib/move-queue.ts): un envío a la vez, gana el ÚLTIMO destino.
      const out = await leadMoves.enqueue(
        leadId,
        { pipeline: toPipeline, stage: toStage },
        { pipeline: before.kommo_pipeline_id, stage: before.kommo_stage_id }
      );
      // Reemplazado por un movimiento más nuevo: ese es el que pinta y avisa.
      if (out.kind === "superseded") return;
      if (out.kind === "failed") {
        // revertTo es null si hay un movimiento más nuevo en cola: la tarjeta ya
        // muestra ESE destino y no debe saltar hacia atrás.
        if (out.revertTo) patch(out.revertTo.pipeline, out.revertTo.stage);
        setAviso({ tone: "error", text: `No se pudo mover a ${nombre}: ${out.message}` });
      } else if (out.kind === "done") {
        setAviso({ tone: out.warning ? "error" : "ok", text: out.warning ?? `${nombre} → ${stageName}` });
      } else if (out.kind === "deferred") {
        // Otro movimiento del lead (otra pestaña/persona) siguió en vuelo: aviso neutro y
        // se relee la posición REAL (no se revierte a una posición que puede ya no ser cierta).
        setAviso({ tone: "info", text: `${nombre}: ${out.message}` });
      }
      if (!leadMoves.isBusy(leadId)) {
        pendingMoves.current.delete(leadId);
        setMovingIds((s) => {
          const n = new Set(s);
          n.delete(leadId);
          return n;
        });
        if (out.kind === "deferred") void load();
      }
    },
    [data, load]
  );

  // ── Sincronizar con Kommo (pipelines/etapas + backfill) ──────────────────
  // El reinicio completo lo concede la base (enfriamiento de 15 min; un recorrido
  // en curso no se rebobina). El botón se deshabilita mientras hay un recorrido en
  // marcha. Dentro del enfriamiento queda habilitado a propósito: refrescar
  // pipelines/etapas (una llamada, con su propio freno de 30 s) sigue siendo útil;
  // lo que no se repite es el recorrido de leads, y el tooltip/aviso lo dicen.
  const [syncing, setSyncing] = useState(false);
  const [syncInfo, setSyncInfo] = useState<{ inProgress: boolean; availableAt: number | null }>({
    inProgress: false,
    availableAt: null,
  });
  const [reloj, setReloj] = useState(() => Date.now());
  const cargarSync = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox/sync", { cache: "no-store" });
      if (!res.ok) return;
      const b = (await res.json())?.backfill as { in_progress?: boolean; retry_after_seconds?: number } | null;
      if (!b) return;
      const wait = Number(b.retry_after_seconds) || 0;
      setReloj(Date.now());
      setSyncInfo({ inProgress: !!b.in_progress, availableAt: wait > 0 ? Date.now() + wait * 1000 : null });
    } catch {
      /* el botón sigue habilitado; la base igual decide */
    }
  }, []);
  useEffect(() => {
    void cargarSync();
  }, [cargarSync]);
  // Mientras haya un recorrido en marcha o un enfriamiento, se refresca el estado.
  useEffect(() => {
    if (!syncInfo.inProgress && !(syncInfo.availableAt && syncInfo.availableAt > Date.now())) return;
    const t = setInterval(() => {
      setReloj(Date.now());
      if (syncInfo.inProgress || (syncInfo.availableAt && syncInfo.availableAt <= Date.now())) void cargarSync();
    }, 15_000);
    return () => clearInterval(t);
  }, [syncInfo, cargarSync]);

  const minutosRestantes = (hasta: number) => Math.max(1, Math.ceil((hasta - reloj) / 60_000));
  const enfriando = !!syncInfo.availableAt && syncInfo.availableAt > reloj;
  const syncBloqueado = syncing || syncInfo.inProgress;
  const syncTitle = syncInfo.inProgress
    ? "Ya está sincronizando con Kommo"
    : enfriando
      ? `Los leads se recorrieron hace poco: se pueden volver a recorrer en ${minutosRestantes(syncInfo.availableAt!)} min (pipelines y etapas sí se actualizan ahora)`
      : "Trae de Kommo los pipelines y la etapa de cada lead";

  async function sincronizar() {
    setSyncing(true);
    try {
      const res = await fetch("/api/inbox/sync", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const state = json?.backfill?.state as string | undefined;
      const wait = Number(json?.backfill?.retry_after_seconds) || 0;
      if (state === "busy" || state === "continuing") {
        setAviso({ tone: "ok", text: "Ya está sincronizando con Kommo… el tablero se actualiza solo." });
      } else if (state === "cooldown") {
        const mins = Math.max(1, Math.ceil(wait / 60));
        setAviso({ tone: "ok", text: `Se sincronizó hace poco: los leads se pueden volver a recorrer en ${mins} min. Pipelines y etapas ya se actualizaron.` });
      } else if (state === "idle") {
        setAviso({ tone: "ok", text: "Pipelines y etapas actualizados. No hay leads pendientes de recorrer." });
      } else if (state === "kommo_not_configured") {
        throw new Error("Kommo todavía no está conectado. Conectalo en Configuración → Kommo y volvé a sincronizar.");
      } else if (state === "unavailable") {
        throw new Error("El recorrido de leads no está disponible: aplicá las migraciones pendientes (0061).");
      } else {
        setAviso({ tone: "ok", text: "Sincronizando con Kommo… el tablero se actualiza solo." });
      }
      // El recorrido de leads sigue en segundo plano: recargar un par de veces.
      setTimeout(() => void load(), 3000);
      setTimeout(() => void load(), 12000);
      void cargarSync();
    } catch (e) {
      setAviso({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const programar = () => {
      if (timer) return; // ya hay una recarga en cola: la ráfaga entra en esa
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, LISTA_MS);
    };
    // Nombre único por montaje (ver realtime de la conversación).
    const channel = supabase
      .channel(`inbox-list-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, programar)
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, programar)
      .on("postgres_changes", { event: "*", schema: "public", table: "drafts" }, programar)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [load]);

  const fQ = (sp.get("q") ?? "").trim().toLowerCase();
  const fChannel = sp.get("channel") ?? "";
  const fVertical = sp.get("vertical") ?? "";
  const fEstado = sp.get("estado") ?? "";
  const fUrgent = sp.get("urgent") === "1";
  const fRango = sp.get("rango") ?? "";
  const fSort = sp.get("sort") ?? "recent";
  const hasActiveFilters =
    !!fQ || !!fChannel || !!fVertical || !!fEstado || fUrgent || !!fRango || fSort !== "recent";
  const fEtapa: EtapaTab = sp.get("etapa") === "apagadas" ? "apagadas" : sp.get("etapa") === "todas" ? "todas" : "agente";

  // Querystring de filtros para conservarlos al abrir una conversación (incluye
  // vista y pipeline: al cerrar el panel se vuelve al mismo tablero).
  // Lista blanca: solo lo que es estado del inbox. Otros parámetros de la URL
  // (setup=open del asistente, ?lead= de enlaces viejos, utm_*) no se propagan a
  // cada tarjeta ni a «Volver».
  const filterQS = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of INBOX_URL_PARAMS) {
      const v = sp.get(k);
      if (v) p.set(k, v);
    }
    return p.toString();
  }, [sp]);

  const all = useMemo(() => data?.leads ?? [], [data]);
  const channelOptions = useMemo(() => Array.from(new Set(all.map((l) => normChannel(l.channel)))).sort(), [all]);
  const verticalOptions = useMemo(() => Array.from(new Set(all.flatMap((l) => l.verticals ?? []))).sort(), [all]);

  const rows = useMemo(() => {
    return all
      .filter((l) => {
        if (fQ) {
          const hay = `${l.display_name ?? ""} ${l.kommo_lead_id ?? ""} ${l.last_content ?? ""}`.toLowerCase();
          if (!hay.includes(fQ)) return false;
        }
        if (fChannel && normChannel(l.channel) !== fChannel) return false;
        if (fVertical && !(l.verticals ?? []).includes(fVertical)) return false;
        if (fUrgent && l.max_urgency < 4) return false;
        if (fEstado === "review" && !l.has_review_pending) return false;
        if (fEstado === "waiting" && !l.awaiting_reply) return false;
        if (fEstado === "answered" && l.last_reply_at == null) return false;
        if (fEstado === "toxic" && l.max_toxicity <= 0.3) return false;
        if (fRango && !withinRange(l.last_message_at, fRango)) return false;
        return true;
      })
      .sort((a, b) => {
        const ta = a.last_message_at ? +new Date(a.last_message_at) : 0;
        const tb = b.last_message_at ? +new Date(b.last_message_at) : 0;
        if (fSort === "oldest") return ta - tb;
        if (fSort === "urgency") return b.max_urgency - a.max_urgency || tb - ta;
        if (fSort === "messages") return b.msg_count - a.msg_count || tb - ta;
        return tb - ta;
      });
  }, [all, fQ, fChannel, fVertical, fEstado, fUrgent, fRango, fSort]);

  // Las tres métricas del topbar miden SIEMPRE el inbox completo, para que no
  // cambien al filtrar ni al saltar de pestaña; lo que se está viendo lo dicen
  // los contadores de las pestañas y el «x de y» de los filtros.
  const totalActive = all.length;
  const pendingReview = all.filter((l) => l.has_review_pending).length;
  const sinResponder = all.filter((l) => l.awaiting_reply).length;

  // Etapa desconocida (todavía sin sincronizar desde Kommo) = el agente SÍ
  // responde: el gate de process-inbound es fail-open. La pestaña refleja el
  // comportamiento real, no el deseado.
  const ignoredStages = useMemo(() => new Set(data?.agentCfg.ignoredStageIds ?? []), [data]);
  const agentHandles = useCallback(
    (stageId: number | null) => stageId == null || !ignoredStages.has(Number(stageId)),
    [ignoredStages]
  );
  // Conteos por pestaña: DESPUÉS del resto de los filtros, para que los números
  // sigan a lo que se está mirando.
  const etapaCounts = useMemo(
    () => ({
      agente: rows.filter((l) => agentHandles(l.kommo_stage_id)).length,
      apagadas: rows.filter((l) => !agentHandles(l.kommo_stage_id)).length,
      todas: rows.length,
    }),
    [rows, agentHandles]
  );
  const listRows = useMemo(
    () =>
      fEtapa === "todas"
        ? rows
        : rows.filter((l) => (fEtapa === "agente" ? agentHandles(l.kommo_stage_id) : !agentHandles(l.kommo_stage_id))),
    [rows, fEtapa, agentHandles]
  );

  const pipelines = useMemo(() => data?.pipelines ?? [], [data]);
  const counts = useMemo(() => pipelineCounts(rows, pipelines), [rows, pipelines]);
  const pipelineParam = Number(sp.get("pipeline"));
  const pipelineId =
    pipelineParam === SIN_UBICAR || pipelineParam === NO_EXISTE || pipelines.some((p) => p.id === pipelineParam)
      ? pipelineParam
      : pipelines[0]?.id ?? SIN_UBICAR;

  // Cerrar el panel de conversación del tablero: volver a /inbox con los filtros.
  const closeHref = `/inbox${filterQS ? `?${filterQS}` : ""}`;

  // Cambiar de pestaña conserva el resto de la URL (filtros, vista) y no navega.
  const setEtapa = (tab: EtapaTab) => setParam("etapa", tab === "agente" ? null : tab);
  useEffect(() => {
    if (vista !== "tablero" || !selectedLead) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.push(closeHref, { scroll: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [vista, selectedLead, closeHref, router]);

  return (
    <div className="flex h-full flex-col bg-neutral-50">
      {/* Topbar sticky manual (Inbox es split-full-height — NO usa PageShell) */}
      <div className="sticky top-0 z-20 border-b border-neutral-200/80 bg-white/80 backdrop-blur-md">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-3 sm:px-6">
          <h1 className="text-[15px] font-semibold tracking-tight text-neutral-900">Inbox</h1>
          {data ? (
            <div className="flex items-center gap-1.5">
              <MiniStat icon={<InboxIcon size={14} />} label="conversaciones" value={totalActive} tone="brand" />
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
          ) : (
            <span className="h-5 w-48 animate-pulse rounded-full bg-neutral-200/70" />
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={sincronizar}
              disabled={syncBloqueado}
              title={syncTitle}
              className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 shadow-sm transition-colors hover:bg-neutral-50 disabled:opacity-50"
            >
              {syncing || syncInfo.inProgress ? "Sincronizando…" : "Sincronizar"}
            </button>
            <div
              className="inline-flex rounded-lg border border-neutral-200 bg-white p-0.5 text-xs font-medium"
              role="group"
              aria-label="Vista"
            >
              {(["tablero", "lista"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={vista === v}
                  onClick={() => setParam("vista", v === "tablero" ? null : v)}
                  className={
                    "rounded-md px-2.5 py-1 transition-colors " +
                    (vista === v ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100")
                  }
                >
                  {v === "tablero" ? "Tablero" : "Lista"}
                </button>
              ))}
            </div>
          </div>
        </div>
        {/* Filtros: en móvil se ocultan mientras hay una conversación abierta (foco en el chat). */}
        <div className={"border-t border-neutral-100 px-4 py-2.5 sm:px-6 " + (selectedLead ? "hidden lg:block" : "block")}>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <InboxFilters channels={channelOptions} verticals={verticalOptions} inline shallow collapsible={isMobile} />
            </div>
            {hasActiveFilters && data && (
              <p className="shrink-0 text-xs text-neutral-500">
                <span className="font-medium text-neutral-700">{rows.length}</span> de {totalActive}
              </p>
            )}
          </div>
        </div>
      </div>

      {vista === "tablero" ? (
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {error && (
            <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
              No se pudo cargar el tablero: {error}{" "}
              <button type="button" className="font-medium underline" onClick={() => void load()}>
                Reintentar
              </button>
            </div>
          )}
          {!data ? (
            <BoardSkeleton />
          ) : (
            <>
              <nav className="flex gap-1 overflow-x-auto border-b border-neutral-200 bg-white px-3 sm:px-4" aria-label="Pipelines">
                {[
                  ...pipelines.map((p) => ({ id: p.id, name: p.name })),
                  ...(counts.get(SIN_UBICAR) ? [{ id: SIN_UBICAR, name: "Sin pipeline" }] : []),
                  ...(counts.get(NO_EXISTE) ? [{ id: NO_EXISTE, name: "No existe en Kommo" }] : []),
                ].map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setParam("pipeline", String(p.id))}
                    aria-current={p.id === pipelineId ? "page" : undefined}
                    className={
                      "shrink-0 border-b-2 px-3 py-2 text-xs font-medium transition-colors " +
                      (p.id === pipelineId
                        ? "border-neutral-900 text-neutral-900"
                        : "border-transparent text-neutral-500 hover:text-neutral-800")
                    }
                  >
                    {p.name}
                    <span className="ml-1.5 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600">
                      {counts.get(p.id) ?? 0}
                    </span>
                  </button>
                ))}
              </nav>
              {pipelineId === SIN_UBICAR && (
                <p className="border-b border-neutral-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                  Estos leads no tienen pipeline asignado todavía o están en un pipeline archivado en Kommo. Lo primero se
                  completa solo al sincronizar con Kommo (cada 10 minutos, o ahora con «Sincronizar»).
                </p>
              )}
              {pipelineId === NO_EXISTE && (
                <p className="border-b border-neutral-200 bg-neutral-100 px-4 py-2 text-xs text-neutral-700">
                  Kommo ya no devuelve estos leads (se borraron allá). No se pueden mover ni responder desde acá y no cuentan
                  como pendientes de ubicar. Si el lead reaparece en Kommo o escribe de nuevo, vuelve solo a su pipeline.
                </p>
              )}
              {pipelines.length === 0 && (
                <p className="border-b border-neutral-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                  Todavía no hay pipelines sincronizados desde Kommo. Usá «Sincronizar» (requiere Kommo conectado).
                </p>
              )}
              <div className="min-h-0 flex-1">
                <Board
                  rows={rows}
                  pipelines={pipelines}
                  pipelineId={pipelineId}
                  selectedLead={selectedLead}
                  filterQS={filterQS}
                  agentCfg={data.agentCfg}
                  onMove={moveLead}
                  movingIds={movingIds}
                />
              </div>
            </>
          )}

          {aviso && <Toast aviso={aviso} />}

          {/* Conversación como panel lateral sobre el tablero */}
          {selectedLead && (
            <div className="absolute inset-0 z-30 flex justify-end">
              <Link
                href={closeHref}
                scroll={false}
                aria-label="Cerrar conversación"
                className="hidden flex-1 bg-neutral-900/20 lg:block"
              />
              <div className="relative flex h-full w-full flex-col bg-neutral-50 shadow-modal lg:w-[min(760px,70vw)]">
                <Link
                  href={closeHref}
                  scroll={false}
                  aria-label="Cerrar conversación"
                  className="absolute right-3 top-3 z-20 hidden rounded-lg px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 lg:inline-flex"
                >
                  ✕
                </Link>
                {children}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {/* Lista — siempre en desktop; en móvil sólo si NO hay conversación abierta */}
          <aside
            className={
              "flex-col border-r border-neutral-200 bg-white lg:flex lg:w-96 " +
              (selectedLead ? "hidden w-full" : "flex w-full")
            }
          >
            {error && (
              <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
                No se pudo cargar la lista: {error}{" "}
                <button type="button" className="font-medium underline" onClick={() => void load()}>
                  Reintentar
                </button>
              </div>
            )}
            {/* Pestañas por etapa: separan lo que el agente atiende de lo que ignora. */}
            <div className="flex shrink-0 gap-1 border-b border-neutral-200 px-2 py-2">
              {ETAPA_TABS.map((t) => {
                const on = fEtapa === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setEtapa(t.id)}
                    aria-pressed={on}
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
                      {data ? etapaCounts[t.id] : "…"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex-1 overflow-y-auto">
              {!data ? (
                <ListSkeleton />
              ) : listRows.length === 0 ? (
                <p className="p-5 text-sm text-neutral-500">
                  {fEtapa === "agente"
                    ? "Ninguna conversación en etapas donde el agente responde."
                    : fEtapa === "apagadas"
                      ? "Ninguna conversación en etapas apagadas."
                      : "Sin conversaciones todavía."}
                </p>
              ) : (
                <LazyReveal
                  items={listRows.map((l) => (
                    <LeadItem
                      key={l.id}
                      lead={l}
                      active={selectedLead === l.id}
                      href={`/inbox/${l.id}${filterQS ? `?${filterQS}` : ""}`}
                      agentCfg={data.agentCfg}
                    />
                  ))}
                />
              )}
            </div>
          </aside>

          {/* Conversación — siempre en desktop; en móvil sólo si HAY conversación */}
          <section
            className={
              "min-w-0 flex-1 flex-col bg-neutral-50 lg:flex " + (selectedLead ? "flex" : "hidden lg:flex")
            }
          >
            {children}
          </section>

          {aviso && <Toast aviso={aviso} />}
        </div>
      )}
    </div>
  );
}

function Toast({ aviso }: { aviso: Aviso }) {
  return (
    <div
      role="status"
      className={
        "pointer-events-none absolute bottom-4 left-1/2 z-40 max-w-[90%] -translate-x-1/2 rounded-lg px-3 py-2 text-xs font-medium shadow-pop " +
        (aviso.tone === "error" ? "bg-red-600 text-white" : "bg-neutral-900 text-white")
      }
    >
      {aviso.text}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex h-full animate-pulse gap-3 overflow-hidden p-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="w-72 shrink-0 space-y-2 rounded-xl border border-neutral-200 bg-neutral-100/70 p-2">
          <div className="h-8 rounded-lg bg-white" />
          {Array.from({ length: 4 }).map((__, j) => (
            <div key={j} className="h-20 rounded-lg bg-white" />
          ))}
        </div>
      ))}
    </div>
  );
}

// Fila de la vista Lista (la misma que tenía el inbox antes del tablero).
function LeadItem({
  lead: l,
  active,
  href,
  agentCfg,
}: {
  lead: LeadSummary;
  active: boolean;
  href: string;
  agentCfg: InboxListData["agentCfg"];
}) {
  const name = l.display_name ?? `Lead ${l.kommo_lead_id ?? "?"}`;
  const agentStatus = computeAgentStatus({ ...agentCfg, stageId: l.kommo_stage_id });
  return (
    <li>
      {/* prefetch off: son cientos de links y cada uno visible pediría su página. */}
      <Link
        href={href}
        prefetch={false}
        scroll={false}
        data-lead-name={name}
        className={"block px-3 py-2 transition-colors " + (active ? "bg-brand-soft" : "hover:bg-neutral-50")}
      >
        <div className="flex items-center gap-2.5">
          <div
            className={
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold " +
              (active ? "bg-brand text-brand-foreground" : "bg-neutral-100 text-neutral-600")
            }
          >
            {initials(name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <p
                className={
                  "truncate text-[13px] font-medium leading-tight " + (active ? "text-brand-strong" : "text-neutral-900")
                }
              >
                {name}
              </p>
              <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-neutral-400">
                <AgentStatusDot status={agentStatus} />
                {l.last_message_at ? timeAgo(l.last_message_at) : "—"}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {l.channel && <ChannelIcon channel={l.channel} size={13} className="shrink-0" />}
              {l.last_content != null && (
                <p className="min-w-0 flex-1 truncate text-[11px] leading-tight text-neutral-500">
                  {l.last_direction === "outbound" ? "→ " : ""}
                  {l.last_content}
                </p>
              )}
              {l.last_vertical && <Badge color="blue" size="sm">{l.last_vertical}</Badge>}
              {l.has_review_pending && <Badge color="amber" size="sm">revisión</Badge>}
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="animate-pulse divide-y divide-neutral-100">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3">
          <div className="h-9 w-9 shrink-0 rounded-full bg-neutral-200" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-32 rounded bg-neutral-200" />
            <div className="h-3 w-44 rounded bg-neutral-200/70" />
            <div className="h-3 w-16 rounded-full bg-neutral-200/70" />
          </div>
        </div>
      ))}
    </div>
  );
}
