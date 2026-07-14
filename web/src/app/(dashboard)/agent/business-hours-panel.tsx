"use client";

// Horario laboral del operador — single source of truth en follow_up_config.
// Modelo por día: business_hours jsonb { "1": {start,end}, ... } (1=Lun..7=Dom,
// día apagado = cerrado). Lo consumen:
//   - generate-response: inyecta en_horario_laboral al contexto del agente
//   - follow_up_due_leads (SQL): ventana horaria de los seguimientos
// Se edita acá (Agente → Filtros) y Seguimiento muestra el resumen.

import { useState } from "react";
import { useRouter } from "next/navigation";

export const DAYS = [
  { label: "Lun", value: 1 },
  { label: "Mar", value: 2 },
  { label: "Mié", value: 3 },
  { label: "Jue", value: 4 },
  { label: "Vie", value: 5 },
  { label: "Sáb", value: 6 },
  { label: "Dom", value: 7 },
];

// Zonas horarias de América (las más usadas) con nombre por país/ciudad.
export const TIMEZONES = [
  { label: "Venezuela — Caracas (UTC−4)", value: "America/Caracas" },
  { label: "Panamá (UTC−5)", value: "America/Panama" },
  { label: "Colombia — Bogotá (UTC−5)", value: "America/Bogota" },
  { label: "Ecuador — Guayaquil (UTC−5)", value: "America/Guayaquil" },
  { label: "Perú — Lima (UTC−5)", value: "America/Lima" },
  { label: "Bolivia — La Paz (UTC−4)", value: "America/La_Paz" },
  { label: "Chile — Santiago (UTC−3)", value: "America/Santiago" },
  { label: "Argentina — Buenos Aires (UTC−3)", value: "America/Argentina/Buenos_Aires" },
  { label: "Uruguay — Montevideo (UTC−3)", value: "America/Montevideo" },
  { label: "Paraguay — Asunción (UTC−3)", value: "America/Asuncion" },
  { label: "Brasil — São Paulo (UTC−3)", value: "America/Sao_Paulo" },
  { label: "México — Ciudad de México (UTC−6)", value: "America/Mexico_City" },
  { label: "México — Cancún (UTC−5)", value: "America/Cancun" },
  { label: "México — Tijuana (UTC−8)", value: "America/Tijuana" },
  { label: "Guatemala / El Salvador / Honduras (UTC−6)", value: "America/Guatemala" },
  { label: "Costa Rica (UTC−6)", value: "America/Costa_Rica" },
  { label: "Nicaragua — Managua (UTC−6)", value: "America/Managua" },
  { label: "Rep. Dominicana (UTC−4)", value: "America/Santo_Domingo" },
  { label: "Puerto Rico (UTC−4)", value: "America/Puerto_Rico" },
  { label: "EE.UU. — Este / Nueva York (UTC−5)", value: "America/New_York" },
  { label: "EE.UU. — Central / Chicago (UTC−6)", value: "America/Chicago" },
  { label: "EE.UU. — Montaña / Denver (UTC−7)", value: "America/Denver" },
  { label: "EE.UU. — Arizona / Phoenix (UTC−7)", value: "America/Phoenix" },
  { label: "EE.UU. — Pacífico / Los Ángeles (UTC−8)", value: "America/Los_Angeles" },
];

export type DayRange = { start: string; end: string };
export type BusinessHours = {
  timezone: string;
  business_hours: Record<string, DayRange> | null;
  business_hours_start: number;
  business_hours_end: number;
  active_days: number[];
};

/** Resumen legible ("Lun a Vie 09:00–21:00; Sáb 09:00–13:00") para mostrar
 *  en Seguimiento y donde haga falta. */
export function formatBusinessHours(cfg: BusinessHours | null): string {
  if (!cfg) return "Lun a Sáb 09:00–20:00 (default)";
  let ranges: Array<{ day: number; text: string }>;
  if (cfg.business_hours) {
    ranges = [];
    for (let d = 1; d <= 7; d++) {
      const r = cfg.business_hours[String(d)];
      if (r) ranges.push({ day: d, text: `${r.start}–${r.end}` });
    }
  } else {
    const text = `${String(cfg.business_hours_start).padStart(2, "0")}:00–${String(cfg.business_hours_end).padStart(2, "0")}:00`;
    ranges = [...(cfg.active_days ?? [])].sort((a, b) => a - b).map((day) => ({ day, text }));
  }
  if (ranges.length === 0) return "sin horario configurado";
  const label = (d: number) => DAYS.find((x) => x.value === d)?.label ?? String(d);
  const groups: Array<{ from: number; to: number; text: string }> = [];
  for (const r of ranges) {
    const last = groups[groups.length - 1];
    if (last && last.text === r.text && r.day === last.to + 1) last.to = r.day;
    else groups.push({ from: r.day, to: r.day, text: r.text });
  }
  return groups
    .map((g) => (g.from === g.to ? `${label(g.from)} ${g.text}` : `${label(g.from)} a ${label(g.to)} ${g.text}`))
    .join("; ");
}

// Estado inicial del editor: jsonb si existe; si no, derivado del legacy.
function toDayMap(initial: BusinessHours | null): Record<number, DayRange | null> {
  const map: Record<number, DayRange | null> = {};
  for (const d of DAYS) {
    if (initial?.business_hours) {
      map[d.value] = initial.business_hours[String(d.value)] ?? null;
    } else if (initial) {
      map[d.value] = initial.active_days?.includes(d.value)
        ? {
            start: `${String(initial.business_hours_start).padStart(2, "0")}:00`,
            end: `${String(initial.business_hours_end).padStart(2, "0")}:00`,
          }
        : null;
    } else {
      map[d.value] = d.value <= 6 ? { start: "09:00", end: "20:00" } : null;
    }
  }
  return map;
}

export function BusinessHoursPanel({ initial }: { initial: BusinessHours | null }) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(initial?.timezone ?? "America/Guayaquil");
  const [days, setDays] = useState<Record<number, DayRange | null>>(() => toDayMap(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function toggleDay(day: number) {
    setDays((prev) => ({
      ...prev,
      [day]: prev[day] ? null : { start: "09:00", end: "20:00" },
    }));
  }

  function setRange(day: number, field: keyof DayRange, value: string) {
    setDays((prev) => (prev[day] ? { ...prev, [day]: { ...prev[day]!, [field]: value } } : prev));
  }

  // Copia el rango de un día a TODOS los días activos (el atajo "L-V igual").
  function copyToActive(day: number) {
    const src = days[day];
    if (!src) return;
    setDays((prev) => {
      const next = { ...prev };
      for (const d of DAYS) if (next[d.value]) next[d.value] = { ...src };
      return next;
    });
  }

  async function save() {
    const business_hours: Record<string, DayRange> = {};
    for (const d of DAYS) {
      const r = days[d.value];
      if (!r) continue;
      if (r.start >= r.end) {
        setError(`${d.label}: la hora de inicio debe ser menor que la de fin.`);
        return;
      }
      business_hours[String(d.value)] = r;
    }
    if (Object.keys(business_hours).length === 0) {
      setError("Activá al menos un día de atención.");
      return;
    }

    // Derivar legacy para compatibilidad (rango ENVOLVENTE + días activos):
    // inicio = piso de la hora más temprana; fin = techo de la más tardía
    // (13:30 → 14, para que el envolvente nunca recorte el horario real).
    const actives = Object.keys(business_hours).map(Number).sort();
    const startMin = Math.min(...actives.map((d) => Number(business_hours[String(d)].start.slice(0, 2))));
    const endMax = Math.max(
      ...actives.map((d) => {
        const [h, m] = business_hours[String(d)].end.split(":").map(Number);
        return m > 0 ? h + 1 : h;
      })
    );

    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/follow-up/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timezone,
        business_hours,
        business_hours_start: startMin,
        business_hours_end: endMax,
        active_days: actives,
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

  const inputCls =
    "rounded-lg border border-neutral-300 px-2 py-1.5 text-sm tabular-nums focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none";

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold tracking-tight text-neutral-900">🕐 Horario laboral</h2>
        <p className="text-xs text-neutral-500">
          El agente sabe si está dentro del horario de atención (para derivar — o no — con un
          asesor humano) y los seguimientos solo se envían dentro de esta ventana. Cada día puede
          tener su propio horario.
        </p>
      </div>

      <div className="max-w-xs space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">Zona horaria</label>
        <select
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        >
          {!TIMEZONES.some((t) => t.value === timezone) && timezone && (
            <option value={timezone}>{timezone}</option>
          )}
          {TIMEZONES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <div className="overflow-x-auto">
          <div className="min-w-[420px] space-y-1">
            {DAYS.map((d) => {
              const range = days[d.value];
              return (
                <div
                  key={d.value}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                    range ? "border-neutral-200 bg-white" : "border-neutral-100 bg-neutral-50"
                  }`}
                >
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(range)}
                    onClick={() => toggleDay(d.value)}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      range ? "bg-neutral-900" : "bg-neutral-300"
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                        range ? "translate-x-[18px]" : "translate-x-1"
                      }`}
                    />
                  </button>
                  <span
                    className={`w-9 text-sm font-medium ${range ? "text-neutral-900" : "text-neutral-400"}`}
                  >
                    {d.label}
                  </span>
                  {range ? (
                    <>
                      <input
                        type="time"
                        value={range.start}
                        onChange={(e) => setRange(d.value, "start", e.target.value)}
                        className={inputCls}
                      />
                      <span className="text-xs text-neutral-400">a</span>
                      <input
                        type="time"
                        value={range.end}
                        onChange={(e) => setRange(d.value, "end", e.target.value)}
                        className={inputCls}
                      />
                      <button
                        type="button"
                        onClick={() => copyToActive(d.value)}
                        title="Copiar este horario a todos los días activos"
                        className="ml-auto rounded-lg border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-800"
                      >
                        ⧉ copiar al resto
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-neutral-400">Cerrado</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Guardando…" : "Guardar horario"}
        </button>
        {saved && <span className="text-xs text-emerald-600">✓ Guardado</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
