"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Alert, Badge } from "@/components/ui";
import { timeAgo } from "@/lib/time-ago";
import {
  initials,
  STAGE_LOST,
  STAGE_WON,
  type BoardPipeline,
  type InboxListData,
  type LeadSummary,
} from "@/lib/inbox-data";
import ChannelIcon from "./channel-icon";
import { computeAgentStatus, AgentStatusDot } from "./agent-status";

// Tablero kanban del inbox: una columna por etapa del pipeline elegido, en el
// orden de Kommo. Lee los MISMOS datos que la lista (inbox-shell.tsx), ya
// filtrados: cambiar de pipeline o de filtro no le pide nada al servidor.
//
// Cada columna muestra de a PAGE tarjetas: PERDIDOS tiene ~940 leads y
// renderizarlos todos de una congela el navegador sin aportar nada.
const PAGE = 25;

/** Id del pseudo-pipeline para leads sin pipeline conocido (borrados en Kommo, etc.). */
export const SIN_UBICAR = -1;
/** Id del pseudo-pipeline de leads que un recorrido completo de Kommo no encontró (borrados allá). */
export const NO_EXISTE = -2;

type Column = {
  key: string;
  stageId: number | null;
  name: string;
  color: string | null;
  leads: LeadSummary[];
  /** Ganados/Perdidos: plegadas por defecto. */
  terminal: boolean;
};

export function pipelineCounts(rows: LeadSummary[], pipelines: BoardPipeline[]): Map<number, number> {
  const known = new Set(pipelines.map((p) => p.id));
  const counts = new Map<number, number>();
  for (const l of rows) {
    const k = l.kommo_missing_at
      ? NO_EXISTE
      : l.kommo_pipeline_id != null && known.has(l.kommo_pipeline_id)
        ? l.kommo_pipeline_id
        : SIN_UBICAR;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export default function Board({
  rows,
  pipelines,
  pipelineId,
  selectedLead,
  filterQS,
  agentCfg,
  onMove,
  movingIds,
}: {
  rows: LeadSummary[];
  pipelines: BoardPipeline[];
  pipelineId: number;
  selectedLead: string | null;
  filterQS: string;
  agentCfg: InboxListData["agentCfg"];
  /** Soltar una tarjeta en otra columna. Sin esto el tablero es solo lectura. */
  onMove?: (leadId: string, pipelineId: number, stageId: number) => void;
  /** Tarjetas con un movimiento en curso (se ven atenuadas). */
  movingIds?: Set<string>;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, number>>({});
  // Columna bajo el cursor mientras se arrastra (para resaltarla).
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Mientras se arrastra, las columnas vacías se estiran para ser fáciles de apuntar.
  const [dragging, setDragging] = useState(false);
  const DRAG_TYPE = "application/x-lead-id";

  const columns = useMemo<Column[]>(() => {
    const known = new Set(pipelines.map((p) => p.id));
    if (pipelineId === NO_EXISTE) {
      return [
        {
          key: "no-existe",
          stageId: null,
          name: "No existe en Kommo",
          color: null,
          leads: rows.filter((l) => l.kommo_missing_at),
          terminal: false,
        },
      ];
    }
    if (pipelineId === SIN_UBICAR) {
      return [
        {
          key: "sin-ubicar",
          stageId: null,
          name: "Sin pipeline",
          color: null,
          leads: rows.filter((l) => !l.kommo_missing_at && (l.kommo_pipeline_id == null || !known.has(l.kommo_pipeline_id))),
          terminal: false,
        },
      ];
    }
    const pipeline = pipelines.find((p) => p.id === pipelineId);
    if (!pipeline) return [];
    const inPipeline = rows.filter((l) => !l.kommo_missing_at && l.kommo_pipeline_id === pipelineId);
    const byStage = new Map<number, LeadSummary[]>();
    for (const l of inPipeline) {
      const k = l.kommo_stage_id ?? -1;
      const list = byStage.get(k) ?? [];
      list.push(l);
      byStage.set(k, list);
    }
    const stageIds = new Set(pipeline.stages.map((s) => s.id));
    const cols: Column[] = pipeline.stages.map((s) => ({
      key: `${pipelineId}:${s.id}`,
      stageId: s.id,
      name: s.name,
      color: s.color,
      leads: byStage.get(s.id) ?? [],
      terminal: s.id === STAGE_WON || s.id === STAGE_LOST,
    }));
    // Etapa que ya no existe en el pipeline (renombrada/borrada en Kommo y
    // todavía sin resincronizar): se muestran aparte en vez de perderse.
    const huerfanos = inPipeline.filter((l) => l.kommo_stage_id == null || !stageIds.has(l.kommo_stage_id));
    if (huerfanos.length > 0) {
      const firstTerminal = cols.findIndex((c) => c.terminal);
      cols.splice(firstTerminal === -1 ? cols.length : firstTerminal, 0, {
        key: `${pipelineId}:otras`,
        stageId: null,
        name: "Etapa desconocida",
        color: null,
        leads: huerfanos,
        terminal: false,
      });
    }
    return cols;
  }, [rows, pipelines, pipelineId]);

  if (columns.length === 0) {
    return <p className="p-6 text-sm text-neutral-500">Este pipeline no tiene etapas sincronizadas todavía. Usá «Sincronizar» para traerlas de Kommo.</p>;
  }

  return (
    <div className="flex h-full snap-x gap-3 overflow-x-auto p-3 sm:snap-none sm:p-4">
      {columns.map((col) => {
        const open = !col.terminal || expanded[col.key];
        const limit = shown[col.key] ?? PAGE;
        // Vacía = angosta: en un pipeline de ventas las 3 primeras etapas suelen estar en 0 y
        // a ancho completo empujaban fuera de la pantalla a las que tienen trabajo.
        const empty = col.leads.length === 0;
        // Solo se puede soltar en una etapa real del pipeline (no en "Sin
        // pipeline" ni en "Etapa desconocida"), y no en la columna de origen.
        const droppable = !!onMove && col.stageId != null && pipelineId > 0;
        const isTarget = dropTarget === col.key;
        return (
          <section
            key={col.key}
            className={
              "flex max-h-full shrink-0 snap-start flex-col rounded-xl border bg-neutral-100/70 transition-colors " +
              (isTarget ? "border-brand bg-brand-soft/60 ring-2 ring-brand/40 " : "border-neutral-200 ") +
              (empty ? "w-36 " + (dragging ? "self-stretch" : "self-start") : open ? "w-[85vw] sm:w-72" : "w-44")
            }
            aria-label={`Etapa ${col.name}`}
            onDragOver={
              droppable
                ? (e) => {
                    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropTarget !== col.key) setDropTarget(col.key);
                  }
                : undefined
            }
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget((t) => (t === col.key ? null : t));
            }}
            onDrop={
              droppable
                ? (e) => {
                    e.preventDefault();
                    setDropTarget(null);
                    setDragging(false);
                    const leadId = e.dataTransfer.getData(DRAG_TYPE);
                    const lead = rows.find((r) => r.id === leadId);
                    if (!lead || lead.kommo_stage_id === col.stageId) return;
                    onMove!(leadId, pipelineId, col.stageId!);
                  }
                : undefined
            }
          >
            <header
              className="rounded-t-xl border-b border-neutral-200 bg-white px-3 py-2"
              style={col.color ? { borderTop: `3px solid ${col.color}` } : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="truncate text-xs font-semibold uppercase tracking-wide text-neutral-700" title={col.name}>
                  {col.name}
                </h3>
                <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-600">
                  {col.leads.length}
                </span>
              </div>
              {col.terminal && !empty && (
                <button
                  type="button"
                  onClick={() => setExpanded((e) => ({ ...e, [col.key]: !open }))}
                  className="mt-1 text-[11px] font-medium text-neutral-500 hover:text-neutral-800"
                >
                  {open ? "Plegar" : "Mostrar"}
                </button>
              )}
            </header>
            {open && !empty && (
              <div className="flex-1 space-y-2 overflow-y-auto p-2">
                {(
                  <>
                    {col.leads.slice(0, limit).map((l) => (
                      <Card
                        key={l.id}
                        lead={l}
                        active={selectedLead === l.id}
                        href={`/inbox/${l.id}${filterQS ? `?${filterQS}` : ""}`}
                        agentCfg={agentCfg}
                        moving={movingIds?.has(l.id) ?? false}
                        onDragStart={
                          onMove && pipelineId > 0
                            ? (e) => {
                                e.dataTransfer.setData(DRAG_TYPE, l.id);
                                e.dataTransfer.effectAllowed = "move";
                                setDragging(true);
                              }
                            : undefined
                        }
                        onDragEnd={() => {
                          setDragging(false);
                          setDropTarget(null);
                        }}
                      />
                    ))}
                    {col.leads.length > limit && (
                      <button
                        type="button"
                        onClick={() => setShown((s) => ({ ...s, [col.key]: limit + PAGE }))}
                        className="w-full rounded-lg border border-dashed border-neutral-300 py-1.5 text-[11px] font-medium text-neutral-500 hover:bg-white"
                      >
                        Ver {Math.min(PAGE, col.leads.length - limit)} más ({col.leads.length - limit} restantes)
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Card({
  lead: l,
  active,
  href,
  agentCfg,
  moving,
  onDragStart,
  onDragEnd,
}: {
  lead: LeadSummary;
  active: boolean;
  href: string;
  agentCfg: InboxListData["agentCfg"];
  moving: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const name = l.display_name ?? `Lead ${l.kommo_lead_id ?? "?"}`;
  const needsAttention = l.has_review_pending || l.max_toxicity > 0.3;
  const agentStatus = computeAgentStatus({ ...agentCfg, stageId: l.kommo_stage_id });
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={false}
      data-lead-name={name}
      draggable={!!onDragStart && !moving}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-busy={moving || undefined}
      title={moving ? "Moviendo en Kommo…" : undefined}
      className={
        "block rounded-lg border bg-white p-2.5 shadow-sm transition " +
        (onDragStart ? "cursor-grab active:cursor-grabbing " : "") +
        (moving ? "pointer-events-none opacity-50 " : "") +
        (active ? "border-brand ring-1 ring-brand" : "border-neutral-200 hover:border-neutral-300")
      }
    >
      <div className="flex items-start gap-2">
        <div className="relative shrink-0">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-100 text-[10px] font-semibold text-neutral-600">
            {initials(name)}
          </div>
          {needsAttention && (
            <span
              className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 ring-2 ring-white"
              title={l.has_review_pending ? "El agente no respondió: requiere revisión humana" : "Mensaje hostil / tóxico — revisalo"}
            >
              <Alert size={8} className="text-white" />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-1.5">
            <p className="truncate text-[13px] font-medium text-neutral-900">{name}</p>
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-neutral-400">
              <AgentStatusDot status={agentStatus} />
              {l.last_message_at ? timeAgo(l.last_message_at) : "—"}
            </span>
          </div>
          {l.last_content != null && (
            <p className="mt-0.5 line-clamp-2 break-words text-[11px] leading-snug text-neutral-500">
              {l.last_direction === "outbound" ? "→ " : ""}
              {l.last_content}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {l.channel && <ChannelIcon channel={l.channel} size={14} className="shrink-0" />}
            {l.last_vertical && <Badge color="blue">{l.last_vertical}</Badge>}
            {l.has_review_pending && <Badge color="amber">revisión</Badge>}
            {!l.has_review_pending && l.max_toxicity > 0.3 && <Badge color="red">hostil</Badge>}
            {l.awaiting_reply && (
              <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">sin responder</span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
