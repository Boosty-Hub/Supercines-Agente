"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Alert, Badge, Inbox as InboxIcon, MessageSquare } from "@/components/ui";
import { timeAgo } from "@/lib/time-ago";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { initials, INBOX_URL_PARAMS, normChannel, type AgentStatusCfg, type LeadSummary } from "@/lib/inbox-data";
import {
  appendPage,
  applyPendingMoves,
  BOARD_PAGE,
  boardLimits,
  findLead,
  LIST_PAGE,
  listRefreshLimit,
  mergeBoardRefresh,
  mergeRefresh,
  moveCard,
  revertMove,
  NO_EXISTE,
  parseEtapa,
  parseFilters,
  parsePipeline,
  parseSort,
  parseVista,
  queryFromFilters,
  SIN_UBICAR,
  type EtapaTab,
  type InboxBoard,
  type InboxPage,
  type InboxResponse,
} from "@/lib/inbox-query";
import ChannelIcon from "./channel-icon";
import InboxFilters from "./filters";
import { computeAgentStatus, AgentStatusDot } from "./agent-status";
import { leadMoves } from "@/lib/move-client";
import Board from "./board";

// La lista/tablero del inbox vive en el LAYOUT (este componente) y la
// conversación en /inbox/[leadId]. Next no vuelve a renderizar un layout al
// navegar entre sus hijos, así que abrir otra conversación no recarga la lista.
//
// Los datos se piden a /api/inbox/leads, que pagina y filtra EN LA BASE
// (migración 0079): por columna del tablero, las primeras tarjetas + el total;
// en la lista, una página. «Ver más» y el scroll piden la siguiente página por
// keyset a /api/inbox/leads/page. Cambiar un filtro, el orden, la vista o el
// pipeline vuelve a pedir; el cliente ya no filtra ni ordena nada.

// Cambios de CUALQUIER lead → se agrupan en una sola recarga de lo VISIBLE (con
// los «Ver más» ya abiertos). Una recarga cada 5 s como máximo.
const LISTA_MS = 5000;

type Aviso = { tone: "error" | "ok" | "info"; text: string };

// Pestaña de la VISTA LISTA según si el agente atiende la etapa del lead. La
// mayoría de los embudos de SuperCines están apagados (ventas por zona, equipo
// interno) y esas conversaciones tapaban a las que sí importan. El tablero NO
// la aplica: es el espejo completo de Kommo y cada tarjeta ya marca con un punto
// si el agente está apagado en su etapa. El filtro lo aplica la base (0085).
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

type Meta = Pick<InboxResponse, "stats" | "agentCfg" | "pipelines">;

export default function InboxShell({ children }: { children: React.ReactNode }) {
  const params = useParams<{ leadId?: string }>();
  const selectedLead = params?.leadId ?? null;
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Vista, pipeline, filtros y orden viven en la URL (se pueden compartir y
  // sobreviven al refresco) y se cambian sin navegar (history.replaceState).
  const vista = parseVista(sp);
  const sort = parseSort(sp);
  const pipelineParam = parsePipeline(sp);
  const fEtapa = parseEtapa(sp);
  // La pestaña sale de parseEtapa (con su default); el resto de los filtros, de la URL.
  const filters = { ...parseFilters(sp), etapa: undefined };
  // La pestaña no es un «filtro activo» (es la pestaña) y solo viaja en la vista Lista.
  const hasActiveFilters = queryFromFilters(filters, sort).toString() !== "";
  const filtersQS = queryFromFilters(
    vista === "lista" && fEtapa !== "todas" ? { ...filters, etapa: fEtapa } : filters,
    sort
  ).toString();
  // Qué se pide: cambia → recarga desde cero (sin los «Ver más» de antes).
  const queryKey = useMemo(() => {
    const p = new URLSearchParams(filtersQS);
    p.set("vista", vista);
    if (vista === "tablero" && pipelineParam != null) p.set("pipeline", String(pipelineParam));
    return p.toString();
  }, [filtersQS, vista, pipelineParam]);

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

  const [meta, setMeta] = useState<Meta | null>(null);
  const [board, setBoard] = useState<InboxBoard | null>(null);
  const [list, setList] = useState<InboxPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargandoVista, setCargandoVista] = useState(false);
  // Refs con lo último que se mostró: la recarga en vivo pide lo mismo que está a la vista.
  const boardRef = useRef(board);
  const listRef = useRef(list);
  boardRef.current = board;
  listRef.current = list;
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  const sortRef = useRef(sort);
  sortRef.current = sort;
  // Clave de lo que hay en pantalla (null = nada todavía).
  const shownKey = useRef<string | null>(null);
  const cargando = useRef(false);
  const pendiente = useRef(false);
  // Destino pedido por lead mientras su movimiento sigue en la cola (lib/move-queue.ts):
  // una recarga que llega en el medio trae la etapa vieja y se corrige con esto.
  const pendingMoves = useRef(new Map<string, { pipeline: number; stage: number }>());

  const load = useCallback(async () => {
    // Una recarga a la vez; si llega otro aviso en el medio, se hace una más al
    // terminar (no se pierde el último cambio, y no se apilan 10 pedidos).
    if (cargando.current) {
      pendiente.current = true;
      return;
    }
    cargando.current = true;
    const key = keyRef.current;
    // Misma consulta que lo que está a la vista → recarga en vivo conservando lo cargado.
    const enVivo = shownKey.current === key;
    const qs = new URLSearchParams(key);
    if (enVivo && qs.get("vista") === "tablero") {
      const limits = boardLimits(boardRef.current);
      if (Object.keys(limits).length > 0) qs.set("limits", JSON.stringify(limits));
    } else if (enVivo) {
      qs.set("limit", String(listRefreshLimit(listRef.current)));
    }
    if (!enVivo) setCargandoVista(true);
    try {
      const res = await fetch(`/api/inbox/leads?${qs.toString()}`, { cache: "no-store" });
      // Sesión vencida: el middleware redirige a /login y llega HTML, no JSON.
      if (res.redirected || !(res.headers.get("content-type") ?? "").includes("json")) {
        window.location.href = "/login";
        return;
      }
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      // El usuario cambió de filtro/vista mientras tanto: esta respuesta ya no sirve.
      if (keyRef.current !== key) {
        pendiente.current = true;
        return;
      }
      const fresh = json as InboxResponse;
      setMeta({ stats: fresh.stats, agentCfg: fresh.agentCfg, pipelines: fresh.pipelines });
      if (fresh.vista === "tablero") {
        // Una recarga que llega con un movimiento en curso trae la etapa VIEJA:
        // se respeta la del movimiento para que la tarjeta no salte hacia atrás. En vivo,
        // lo que se cargó con «Ver más» mientras la recarga viajaba no se pierde.
        const b = applyPendingMoves(fresh.board, pendingMoves.current, sortRef.current);
        setBoard((cur) => (enVivo ? mergeBoardRefresh(cur, b) : b));
        setList(null);
      } else {
        setList((cur) => (enVivo ? mergeRefresh(cur, fresh.list) : fresh.list));
        setBoard(null);
      }
      shownKey.current = key;
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Falló la carga de OTRA consulta (filtro, vista, pipeline): no se deja a la vista
      // lo de la consulta anterior bajo los controles nuevos.
      if (!enVivo) {
        shownKey.current = null;
        setBoard(null);
        setList(null);
      }
    } finally {
      cargando.current = false;
      setCargandoVista(false);
      if (pendiente.current) {
        pendiente.current = false;
        void load();
      }
    }
  }, []);

  // Primera carga y cada cambio de vista/pipeline/filtros/orden.
  useEffect(() => {
    void load();
  }, [queryKey, load]);

  useEffect(() => {
    // "Mover a…" de la conversación avisa por acá para que el tablero no espere
    // al refresco en vivo (5 s) para mover la tarjeta.
    const onReload = () => void load();
    window.addEventListener("inbox:reload", onReload);
    return () => window.removeEventListener("inbox:reload", onReload);
  }, [load]);

  // ── «Ver más» (columna del tablero) y scroll de la lista ─────────────────
  const [loadingMore, setLoadingMore] = useState<Set<string>>(() => new Set());
  const enVuelo = useRef(new Set<string>());
  // Cursor cuya página falló: el scroll no lo reintenta solo (sería un bucle de
  // pedidos); el botón «Cargar más»/«Ver más» sí.
  const [fallido, setFallido] = useState<string | null>(null);
  const loadMore = useCallback(async (colKey: string) => {
    const key = keyRef.current;
    const b = boardRef.current;
    const l = listRef.current;
    const enLista = colKey === "__lista";
    const cursor = enLista ? l?.next : b?.columns[colKey]?.next;
    if (!cursor || shownKey.current !== key || enVuelo.current.has(colKey)) return;
    enVuelo.current.add(colKey);
    setFallido(null);
    const qs = new URLSearchParams(key);
    qs.delete("vista");
    qs.delete("pipeline");
    if (!enLista && b) {
      qs.set("pipeline", String(b.pipeline));
      qs.set("stage", colKey);
    }
    qs.set("after", JSON.stringify(cursor));
    qs.set("limit", String(enLista ? LIST_PAGE : BOARD_PAGE));
    setLoadingMore((s) => new Set(s).add(colKey));
    try {
      const res = await fetch(`/api/inbox/leads/page?${qs.toString()}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (keyRef.current !== key) return;
      const page = json as InboxPage;
      if (enLista) setList((cur) => (cur ? appendPage(cur, page) : cur));
      else
        setBoard((cur) =>
          cur && b && cur.pipeline === b.pipeline && cur.columns[colKey]
            ? { ...cur, columns: { ...cur.columns, [colKey]: appendPage(cur.columns[colKey], page) } }
            : cur
        );
    } catch (e) {
      setFallido(JSON.stringify(cursor));
      setAviso({ tone: "error", text: `No se pudieron cargar más conversaciones: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      enVuelo.current.delete(colKey);
      setLoadingMore((s) => {
        const n = new Set(s);
        n.delete(colKey);
        return n;
      });
    }
  }, []);

  const [aviso, setAviso] = useState<Aviso | null>(null);
  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(null), aviso.tone === "error" ? 8000 : aviso.tone === "info" ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [aviso]);

  // ── Mover de etapa ───────────────────────────────────────────────────────
  // Optimista: la tarjeta cambia de columna al soltarla (con los totales de las
  // dos columnas) y, si Kommo falla, vuelve a donde estaba con el motivo en un aviso.
  const [movingIds, setMovingIds] = useState<Set<string>>(() => new Set());
  const moveLead = useCallback(
    async (leadId: string, toPipeline: number, toStage: number) => {
      const before = boardRef.current ? findLead(boardRef.current, leadId) : null;
      if (!before) return;
      const place = (pipeline: number, stage: number) =>
        setBoard((b) => (b ? moveCard(b, leadId, { pipeline, stage }, sortRef.current) : b));
      place(toPipeline, toStage);
      pendingMoves.current.set(leadId, { pipeline: toPipeline, stage: toStage });
      setMovingIds((s) => new Set(s).add(leadId));
      const stageName =
        meta?.pipelines.find((p) => p.id === toPipeline)?.stages.find((s) => s.id === toStage)?.name ?? `#${toStage}`;
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
        if (out.revertTo) {
          setBoard((b) => (b ? revertMove(b, before, { pipeline: toPipeline, stage: toStage }, sortRef.current) : b));
        }
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
        // Los totales y la posición real los confirma la base.
        if (out.kind !== "done") void load();
      }
    },
    [meta, load]
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

  const stats = meta?.stats ?? null;
  const pipelines = useMemo(() => meta?.pipelines ?? [], [meta]);
  const channelOptions = useMemo(
    () => Array.from(new Set((stats?.channels ?? []).map((c) => normChannel(c)))).sort(),
    [stats]
  );
  const verticalOptions = useMemo(() => stats?.verticals ?? [], [stats]);
  // Pipeline a la vista: el que resolvió el servidor (uno inválido o archivado cae al principal).
  const pipelineId = board?.pipeline ?? pipelineParam ?? pipelines[0]?.id ?? SIN_UBICAR;
  const pipelineCount = (id: number) => stats?.pipelines[String(id)] ?? 0;

  // Cerrar el panel de conversación del tablero: volver a /inbox con los filtros.
  const closeHref = `/inbox${filterQS ? `?${filterQS}` : ""}`;
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
          {stats ? (
            // Las tres métricas del topbar miden SIEMPRE el inbox completo, para que no
            // cambien al filtrar ni al saltar de pestaña; lo que se está viendo lo dicen
            // los contadores de las pestañas y el «x de y» de los filtros.
            <div className="flex items-center gap-1.5">
              <MiniStat icon={<InboxIcon size={14} />} label="conversaciones" value={stats.total} tone="brand" />
              <MiniStat
                icon={<MessageSquare size={14} />}
                label="sin responder"
                value={stats.awaiting_all}
                tone={stats.awaiting_all > 0 ? "amber" : "default"}
              />
              <MiniStat
                icon={<Alert size={14} />}
                label="en revisión"
                value={stats.review}
                tone={stats.review > 0 ? "red" : "default"}
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
            {hasActiveFilters && stats && (
              <p className="shrink-0 text-xs text-neutral-500" aria-live="polite">
                <span className="font-medium text-neutral-700">{stats.filtered}</span> de {stats.total}
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
          {!board || !meta ? (
            error ? null : <BoardSkeleton />
          ) : (
            <>
              <nav className="flex gap-1 overflow-x-auto border-b border-neutral-200 bg-white px-3 sm:px-4" aria-label="Pipelines">
                {[
                  ...pipelines.map((p) => ({ id: p.id, name: p.name })),
                  ...(pipelineCount(SIN_UBICAR) || pipelineId === SIN_UBICAR ? [{ id: SIN_UBICAR, name: "Sin pipeline" }] : []),
                  ...(pipelineCount(NO_EXISTE) || pipelineId === NO_EXISTE ? [{ id: NO_EXISTE, name: "No existe en Kommo" }] : []),
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
                      {pipelineCount(p.id)}
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
              <div className={"min-h-0 flex-1 transition-opacity " + (cargandoVista ? "opacity-60" : "")} aria-busy={cargandoVista || undefined}>
                <Board
                  board={board}
                  pipelines={pipelines}
                  selectedLead={selectedLead}
                  filterQS={filterQS}
                  agentCfg={meta.agentCfg}
                  onMove={moveLead}
                  onLoadMore={(k) => void loadMore(k)}
                  loadingMore={loadingMore}
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
                    onClick={() => setParam("etapa", t.id === "agente" ? null : t.id)}
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
                      {stats ? stats.etapa[t.id] : "…"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className={"flex-1 overflow-y-auto transition-opacity " + (cargandoVista ? "opacity-60" : "")} aria-busy={cargandoVista || undefined}>
              {!list || !meta ? (
                error ? null : <ListSkeleton />
              ) : list.rows.length === 0 ? (
                <p className="p-5 text-sm text-neutral-500">
                  {hasActiveFilters
                    ? "Ninguna conversación coincide con los filtros."
                    : fEtapa === "agente"
                      ? "Ninguna conversación en etapas donde el agente responde."
                      : fEtapa === "apagadas"
                        ? "Ninguna conversación en etapas apagadas."
                        : "Sin conversaciones todavía."}
                </p>
              ) : (
                <ul className="divide-y divide-neutral-100">
                  {list.rows.map((l) => (
                    <LeadItem
                      key={l.id}
                      lead={l}
                      active={selectedLead === l.id}
                      href={`/inbox/${l.id}${filterQS ? `?${filterQS}` : ""}`}
                      agentCfg={meta.agentCfg}
                    />
                  ))}
                  {list.next && (
                    <MoreSentinel
                      loading={loadingMore.has("__lista")}
                      auto={fallido !== JSON.stringify(list.next)}
                      rows={list.rows.length}
                      onVisible={() => void loadMore("__lista")}
                    />
                  )}
                </ul>
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

// Fin de la lista: al asomarse (300 px antes) pide la página siguiente. También es un
// botón, para teclado y por si el observer no dispara (pantallas muy altas).
// Si la página falló (auto=false) no se reintenta sola: queda el botón.
function MoreSentinel({
  loading,
  auto,
  rows,
  onVisible,
}: {
  loading: boolean;
  auto: boolean;
  /** Filas a la vista: al cambiar, el observer se vuelve a armar (lista corta tras un filtro). */
  rows: number;
  onVisible: () => void;
}) {
  const ref = useRef<HTMLLIElement | null>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || loading || !auto) return;
    const obs = new IntersectionObserver((entries) => entries[0]?.isIntersecting && cb.current(), { rootMargin: "300px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [loading, auto, rows]);
  return (
    <li ref={ref} className="px-4 py-3 text-center">
      <button
        type="button"
        disabled={loading}
        onClick={() => cb.current()}
        className="text-xs font-medium text-neutral-500 hover:text-neutral-800 disabled:opacity-60"
      >
        {loading ? "Cargando más…" : auto ? "Cargar más" : "Reintentar: cargar más"}
      </button>
    </li>
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
  agentCfg: AgentStatusCfg;
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
