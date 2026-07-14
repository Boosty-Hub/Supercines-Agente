// Charts server-safe (sin "use client", sin librerías externas).
// SVG puro para LineAreaChart y BarBreakdown; CSS grid para HeatmapGrid.
import React from "react";

// ---- Colores por componente ----
const COMPONENT_COLORS: Record<string, string> = {
  generate_response: "#6366f1", // brand/indigo
  classify:          "#f59e0b", // amber
  dreams:            "#10b981", // emerald
  grader:            "#8b5cf6", // purple
};
function componentColor(label: string): string {
  return COMPONENT_COLORS[label] ?? "#94a3b8"; // neutral fallback
}

// ---- LineAreaChart ----
export type LineAreaSeries = { label: string; color: string; values: number[] };

export function LineAreaChart(props: {
  days: string[];
  series: LineAreaSeries[];
  formatY?: (n: number) => string;
}): React.JSX.Element {
  const { days, series, formatY = (n) => `$${n.toFixed(2)}` } = props;
  const W = 800; const H = 240; const PAD = { top: 16, right: 16, bottom: 40, left: 60 };
  const inner = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };

  if (days.length === 0 || series.length === 0) {
    return <div className="flex h-40 items-center justify-center text-xs text-neutral-400">Sin datos</div>;
  }

  // Aggregate stacked max
  const totals = days.map((_, i) => series.reduce((s, ser) => s + (ser.values[i] ?? 0), 0));
  const maxVal = Math.max(...totals, 0.001);

  const xStep = inner.w / Math.max(days.length - 1, 1);
  const yScale = (v: number) => inner.h - (v / maxVal) * inner.h;
  const xScale = (i: number) => i * xStep;

  // Y axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ v: maxVal * t, y: yScale(maxVal * t) }));

  // X axis labels (show at most 7 evenly spaced)
  const xStep2 = Math.max(1, Math.floor(days.length / 7));
  const xLabels = days.reduce<{ i: number; label: string }[]>((acc, d, i) => {
    if (i % xStep2 === 0 || i === days.length - 1) acc.push({ i, label: d.slice(5) }); // MM-DD
    return acc;
  }, []);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 280, maxHeight: 260 }}>
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {/* Y grid + labels */}
          {yTicks.map(({ v, y }) => (
            <g key={v}>
              <line x1={0} x2={inner.w} y1={y} y2={y} stroke="#e5e7eb" strokeWidth={1} />
              <text x={-6} y={y + 4} textAnchor="end" fontSize={10} fill="#9ca3af">{formatY(v)}</text>
            </g>
          ))}
          {/* X labels */}
          {xLabels.map(({ i, label }) => (
            <text key={i} x={xScale(i)} y={inner.h + 20} textAnchor="middle" fontSize={10} fill="#9ca3af">{label}</text>
          ))}
          {/* Areas (stacked, back to front) */}
          {series.map((ser) => {
            const pts = ser.values.map((v, i) => `${xScale(i)},${yScale(v)}`).join(" ");
            const area = `${xScale(0)},${inner.h} ` + pts + ` ${xScale(days.length - 1)},${inner.h}`;
            return (
              <polygon key={ser.label} points={area} fill={ser.color} opacity={0.18} />
            );
          })}
          {/* Lines */}
          {series.map((ser) => {
            const pts = ser.values.map((v, i) => `${xScale(i)},${yScale(v)}`).join(" ");
            return (
              <polyline key={ser.label} points={pts} fill="none" stroke={ser.color} strokeWidth={2} />
            );
          })}
          {/* Legend */}
          {series.map((ser, i) => (
            <g key={ser.label} transform={`translate(${i * 140},${inner.h + 30})`}>
              <rect x={0} y={-8} width={10} height={10} fill={ser.color} rx={2} />
              <text x={14} y={0} fontSize={11} fill="#6b7280">{ser.label}</text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

// ---- BarBreakdown ----
export function BarBreakdown(props: {
  rows: { label: string; value: number; estimated?: boolean }[];
  formatValue?: (n: number) => string;
}): React.JSX.Element {
  const { rows, formatValue = (n) => `$${n.toFixed(4)}` } = props;
  if (rows.length === 0) return <div className="text-xs text-neutral-400">Sin datos</div>;

  const max = Math.max(...rows.map((r) => r.value), 0.001);
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-3">
          <div className="w-36 shrink-0 text-xs text-neutral-600 truncate" title={row.label}>
            {row.label}
          </div>
          <div className="flex-1 relative h-5 rounded-full bg-neutral-100 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max((row.value / max) * 100, 1).toFixed(1)}%`,
                background: row.estimated
                  ? "repeating-linear-gradient(45deg,#94a3b8,#94a3b8 3px,#e2e8f0 3px,#e2e8f0 8px)"
                  : componentColor(row.label),
              }}
            />
          </div>
          <div className="w-24 text-right text-xs font-medium text-neutral-700 tabular-nums">
            {formatValue(row.value)}
            {row.estimated && (
              <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">est.</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- HeatmapGrid ----
const DOW_LABELS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]; // isodow 1..7

export function HeatmapGrid(props: {
  cells: { dow: number; hour: number; value: number }[];
  max: number;
  label?: (c: { dow: number; hour: number; value: number }) => string;
}): React.JSX.Element {
  const { cells, max, label } = props;

  const cellMap = new Map<string, number>();
  for (const c of cells) cellMap.set(`${c.dow}:${c.hour}`, c.value);

  const getIntensity = (v: number) => max > 0 ? v / max : 0;

  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: 560 }}>
        {/* Hour labels row */}
        <div className="flex gap-px mb-0.5">
          <div className="w-8 shrink-0" />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 text-center text-[9px] text-neutral-400">
              {h % 4 === 0 ? `${h}h` : ""}
            </div>
          ))}
        </div>
        {/* DOW rows */}
        {DOW_LABELS.map((dow, di) => {
          const dowNum = di + 1; // isodow 1=Lun
          return (
            <div key={dow} className="flex gap-px mb-px items-center">
              <div className="w-8 shrink-0 text-[10px] text-neutral-400">{dow}</div>
              {Array.from({ length: 24 }, (_, h) => {
                const v = cellMap.get(`${dowNum}:${h}`) ?? 0;
                const intensity = getIntensity(v);
                const alpha = Math.round(intensity * 255).toString(16).padStart(2, "0");
                const bg = intensity > 0 ? `#6366f1${alpha}` : "#f1f5f9";
                const title = label ? label({ dow: dowNum, hour: h, value: v }) : `${dow} ${h}h: ${v}`;
                return (
                  <div
                    key={h}
                    title={title}
                    className="flex-1 h-5 rounded-sm cursor-default"
                    style={{ backgroundColor: bg }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
