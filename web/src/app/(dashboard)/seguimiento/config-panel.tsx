"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { TIMEZONES, formatBusinessHours, type DayRange } from "../agent/business-hours-panel";
import { StageSelector } from "./stage-selector";
import { UserSelector } from "./user-selector";

type Config = {
  id: string;
  enabled: boolean;
  timezone: string;
  business_hours: Record<string, DayRange> | null;
  business_hours_start: number;
  business_hours_end: number;
  active_days: number[];
  max_follow_ups: number;
  min_gap_hours: number;
  run_stage_ids: number[];
  run_user_ids: number[];
  notes: string | null;
} | null;

// Chip de resumen del header (un dato puntual, legible de un vistazo).
function Chip({
  dot,
  children,
}: {
  dot?: "emerald" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-0.5 text-[11px] font-medium text-neutral-600">
      {dot && (
        <span
          className={
            "h-1.5 w-1.5 rounded-full " +
            (dot === "emerald" ? "bg-emerald-500" : "bg-neutral-400")
          }
        />
      )}
      {children}
    </span>
  );
}

export function ConfigPanel({ config }: { config: Config }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [maxFollowUps, setMaxFollowUps] = useState(config?.max_follow_ups ?? 3);
  const [minGapHours, setMinGapHours] = useState(config?.min_gap_hours ?? 20);
  const [runStageIds, setRunStageIds] = useState<number[]>(config?.run_stage_ids ?? []);
  const [runUserIds, setRunUserIds] = useState<number[]>(config?.run_user_ids ?? []);
  const [notes, setNotes] = useState(config?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Resumen para el header colapsado (refleja el estado en vivo del form).
  const tzLabel =
    TIMEZONES.find((t) => t.value === (config?.timezone ?? ""))?.label ??
    config?.timezone ??
    "—";
  const stagesLabel =
    runStageIds.length === 0
      ? "Todas las etapas"
      : `${runStageIds.length} etapa${runStageIds.length > 1 ? "s" : ""}`;
  const usersLabel =
    runUserIds.length === 0
      ? "Todos los vendedores"
      : `${runUserIds.length} vendedor${runUserIds.length > 1 ? "es" : ""}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    const res = await fetch("/api/follow-up/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled,
        max_follow_ups: maxFollowUps,
        min_gap_hours: minGapHours,
        run_stage_ids: runStageIds,
        run_user_ids: runUserIds,
        notes: notes.trim() || null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError((j as { error?: string }).error ?? "Error al guardar");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm p-5 space-y-4">
      {/* Header colapsable: resumen de un vistazo + chevron */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0 space-y-2">
          <h2 className="text-base font-semibold tracking-tight text-neutral-900">
            Configuración global
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip dot={enabled ? "emerald" : "neutral"}>
              {enabled ? "Activo" : "Pausado"}
            </Chip>
            <Chip>🕐 {formatBusinessHours(config)}</Chip>
            <Chip>{stagesLabel}</Chip>
            <Chip>{usersLabel}</Chip>
          </div>
        </div>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden
          className={
            "mt-1 h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 motion-reduce:transition-none " +
            (open ? "rotate-180" : "")
          }
        >
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <form onSubmit={save} className={open ? "space-y-4" : "hidden"}>
        {/* Enable toggle */}
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((v) => !v)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-neutral-900 ${
              enabled ? "bg-neutral-900" : "bg-neutral-300"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
          <span className="text-sm font-medium text-neutral-900">
            {enabled ? "Seguimiento activado" : "Seguimiento desactivado"}
          </span>
          {enabled && (
            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              ACTIVO
            </span>
          )}
        </label>

        {/* Horario laboral — se configura en Agente (single source of truth);
            acá solo se muestra el resumen para no duplicar editores. */}
        <div className="rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
          🕐 Los seguimientos se envían dentro del{" "}
          <span className="font-medium">horario laboral</span> configurado en{" "}
          <a href="/agent?tab=filtros" className="font-medium text-neutral-800 underline">
            Agente → Filtros
          </a>
          : {tzLabel} · {formatBusinessHours(config)}.
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Max follow-ups */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-600">Máximo de seguimientos por lead</label>
            <input
              type="number"
              min={1}
              max={10}
              value={maxFollowUps}
              onChange={(e) => setMaxFollowUps(Number(e.target.value))}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
            />
          </div>

          {/* Min gap hours */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-600">Mínimo de horas entre envíos al mismo lead</label>
            <input
              type="number"
              min={1}
              max={168}
              value={minGapHours}
              onChange={(e) => setMinGapHours(Number(e.target.value))}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
            />
          </div>
        </div>

        {/* Etapas donde corre el seguimiento (lista blanca, selector visual) */}
        <StageSelector value={runStageIds} onChange={setRunStageIds} />

        {/* Vendedores cuyos leads reciben seguimiento (lista blanca) */}
        <UserSelector value={runUserIds} onChange={setRunUserIds} />

        {/* Notes */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">Notas internas (opcional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {saved && <p className="text-sm text-emerald-600">Guardado correctamente.</p>}

        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Guardando…" : "Guardar configuración"}
        </button>
      </form>
    </div>
  );
}
