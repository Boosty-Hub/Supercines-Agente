"use client";

import { useState } from "react";
import { SectionCard, StatRow, StatCard, EmptyState, SegmentedControl, BarChart3, TrendUp, Check, Bot } from "@/components/ui";
import { FunnelChart, BarBreakdown, LineAreaChart, type LineAreaSeries } from "../consumo/charts";
import { FLOW_LABELS, STEP_LABELS, type FlowType, type FunnelLeadRow } from "./steps";

export default function SalesbotFunnelTabs({
  rows,
  rangeDays,
}: {
  rows: FunnelLeadRow[];
  rangeDays: number;
}) {
  const [tab, setTab] = useState<FlowType>("cumpleanos");

  const tabs: { key: FlowType; label: string }[] = [
    { key: "cumpleanos", label: FLOW_LABELS.cumpleanos },
    { key: "alquiler_salas", label: FLOW_LABELS.alquiler_salas },
  ];

  const filtered = rows.filter((r) => r.flow_type === tab);
  const labels = STEP_LABELS[tab];
  const total = filtered.length;
  const reachedCount = filtered.filter((r) => r.reached_human).length;
  const pctReached = total > 0 ? Math.round((reachedCount / total) * 100) : null;
  const stuckCount = total - reachedCount;

  // "Al menos llegó hasta este paso" — acumulado, de ahí la forma de funnel.
  const funnelSteps = labels.map((label, i) => ({
    label,
    count: filtered.filter((r) => r.furthest_step_index >= i).length,
  }));

  // Distribución de dónde se quedó cada lead que NO llegó a la asesora.
  const stuckRows = labels
    .map((label, i) => ({
      label,
      value: filtered.filter((r) => !r.reached_human && r.furthest_step_index === i).length,
    }))
    .filter((r) => r.value > 0);

  // Tendencia diaria (rellena días sin datos con 0 para que la línea no salte).
  const days: string[] = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
  }
  const byDay = new Map<string, number>();
  for (const r of filtered) {
    const day = r.kommo_created_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const trendSeries: LineAreaSeries[] = [
    { label: "Conversaciones iniciadas", color: "#6366f1", values: days.map((d) => byDay.get(d) ?? 0) },
  ];

  return (
    <div className="space-y-6">
      <SegmentedControl
        items={tabs.map((t) => ({ id: t.key, label: t.label }))}
        value={tab}
        onChange={setTab}
        aria-label="Tipo de flujo"
      />

      {total === 0 ? (
        <EmptyState
          icon={<Bot size={24} />}
          title="Sin conversaciones en este período"
          description="No hubo leads que iniciaran este flujo en el rango y sede seleccionados."
        />
      ) : (
        <>
          <StatRow>
            <StatCard label="Iniciaron conversación" value={total} icon={<Bot size={17} />} tone="brand" />
            <StatCard
              label="Llegaron a la asesora"
              value={pctReached !== null ? `${pctReached}%` : "—"}
              hint={`${reachedCount} de ${total}`}
              icon={<Check size={17} />}
              tone={pctReached !== null && pctReached >= 50 ? "emerald" : "amber"}
            />
            <StatCard
              label="Se estancaron"
              value={stuckCount}
              icon={<TrendUp size={17} />}
              tone={stuckCount > 0 ? "amber" : "default"}
            />
          </StatRow>

          <SectionCard
            icon={<TrendUp size={17} />}
            title="Recorrido del bot"
            description="Cuántos leads llegaron al menos hasta cada paso (acumulado)"
          >
            <FunnelChart steps={funnelSteps} />
          </SectionCard>

          {stuckRows.length > 0 && (
            <SectionCard
              icon={<BarChart3 size={17} />}
              title="¿Dónde se estancan?"
              description="Último paso alcanzado por los que NO llegaron a la asesora"
            >
              <BarBreakdown rows={stuckRows} formatValue={(n) => String(n)} />
            </SectionCard>
          )}

          <SectionCard icon={<BarChart3 size={17} />} title="Conversaciones por día" description={`Últimos ${rangeDays} días`}>
            <LineAreaChart days={days} series={trendSeries} formatY={(n) => String(Math.round(n))} />
          </SectionCard>

          <SectionCard
            icon={<Bot size={17} />}
            title="Detalle"
            description="Leads de este flujo en el período, más recientes primero"
          >
            <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead className="sticky top-0 bg-neutral-50/60 text-left">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Fecha</th>
                      <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Lead</th>
                      <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Último paso alcanzado</th>
                      <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {filtered.slice(0, 100).map((r) => (
                      <tr key={r.kommo_lead_id} className="hover:bg-neutral-50/70 transition-colors">
                        <td className="px-4 py-3 text-xs text-neutral-500 tabular-nums">{r.kommo_created_at.slice(0, 10)}</td>
                        <td className="px-4 py-3 text-sm text-neutral-700">{r.contact_name || `Lead ${r.kommo_lead_id}`}</td>
                        <td className="px-4 py-3 text-sm text-neutral-600">{labels[r.furthest_step_index]}</td>
                        <td className="px-4 py-3">
                          <span
                            className={
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
                              (r.reached_human ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")
                            }
                          >
                            {r.reached_human ? "Con asesora" : "Estancado"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {filtered.length > 100 && (
              <p className="mt-2 text-xs text-neutral-400">Mostrando los 100 más recientes de {filtered.length}.</p>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
