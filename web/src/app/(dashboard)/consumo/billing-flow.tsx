// "El recorrido del dinero": cada punto del pipeline donde Anthropic cobra,
// con el modelo configurado y el costo promedio REAL medido en el período.
// Server component puro — recibe todo por props desde page.tsx.

export type BillingPoint = {
  key: string;
  emoji: string;
  title: string;
  model: string | null;       // null = paso gratis
  charges: string;            // qué se factura, en lenguaje humano
  avgCost: number | null;     // promedio real por evento (USD); null = sin datos
  unit: string;               // "por mensaje", "por respuesta", …
  calls: number;              // eventos en el período
  share: number;              // % del costo total del período
  note?: string;
  // Si el período se midió con otro(s) modelo(s) que el configurado ahora
  // (ej: ayer Sonnet, hoy Haiku), lo aclaramos: el promedio es histórico real.
  measuredWith?: string;
  // Desglose del costo del punto por tipo (caché write/read, output, runtime).
  breakdown?: { label: string; usd: number }[];
};

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

const SHORT_MODEL: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-8": "Opus 4.8",
};

export function BillingFlow({ points }: { points: BillingPoint[] }) {
  return (
    <ol className="relative space-y-0">
      {points.map((p, i) => (
        <li key={p.key} className="relative flex gap-3 pb-4 last:pb-0">
          {/* línea vertical conectora */}
          {i < points.length - 1 && (
            <span className="absolute left-[15px] top-8 h-[calc(100%-24px)] w-px bg-neutral-200" aria-hidden />
          )}
          <span
            className={`z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm ${
              p.model === null
                ? "border-neutral-200 bg-white"
                : p.share >= 50
                ? "border-indigo-300 bg-indigo-50"
                : "border-neutral-300 bg-neutral-50"
            }`}
          >
            {p.emoji}
          </span>
          <div className="min-w-0 flex-1 rounded-xl border border-neutral-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-sm font-semibold text-neutral-900">{p.title}</p>
              {p.model === null ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  gratis
                </span>
              ) : (
                <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] font-medium text-white">
                  {SHORT_MODEL[p.model] ?? p.model}
                </span>
              )}
              {p.share > 0 && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    p.share >= 50 ? "bg-indigo-100 text-indigo-700" : "bg-neutral-100 text-neutral-600"
                  }`}
                >
                  {p.share.toFixed(p.share < 1 ? 1 : 0)}% del gasto
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-neutral-500">{p.charges}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs">
              {p.avgCost != null && p.avgCost > 0 && (
                <span className="font-mono font-semibold text-neutral-900">
                  ≈ {usd(p.avgCost)} {p.unit}
                </span>
              )}
              {p.calls > 0 && <span className="text-neutral-400">{p.calls.toLocaleString()} veces en el período</span>}
              {p.note && <span className="text-amber-700">{p.note}</span>}
            </div>
            {p.measuredWith && (
              <p className="mt-1 text-[11px] text-neutral-400">⚠ {p.measuredWith} — el badge muestra el modelo configurado de acá en más</p>
            )}
            {p.breakdown && p.breakdown.some((b) => b.usd > 0) && (
              <div className="mt-2 space-y-1 rounded-lg bg-neutral-50 p-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  ¿En qué se va este cobro? (período completo)
                </p>
                {(() => {
                  const total = p.breakdown.reduce((s, b) => s + b.usd, 0);
                  const max = Math.max(...p.breakdown.map((b) => b.usd), 0.0001);
                  return p.breakdown
                    .filter((b) => b.usd > 0.0001)
                    .map((b) => (
                      <div key={b.label} className="flex items-center gap-2">
                        <span className="w-56 shrink-0 truncate text-[11px] text-neutral-600" title={b.label}>
                          {b.label}
                        </span>
                        <span className="h-2 rounded-full bg-indigo-400" style={{ width: `${Math.max(2, (b.usd / max) * 100 * 0.5)}%` }} />
                        <span className="shrink-0 font-mono text-[11px] font-semibold text-neutral-800">
                          ${b.usd.toFixed(2)} ({total > 0 ? ((b.usd / total) * 100).toFixed(0) : 0}%)
                        </span>
                      </div>
                    ));
                })()}
                <p className="pt-1 text-[10px] text-neutral-400">
                  En la factura de Anthropic estos conceptos aparecen como: escritura de caché (primera leída),
                  lectura de caché (repasos), output (escribir), input y runtime.
                </p>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
