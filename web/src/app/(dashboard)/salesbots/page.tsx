import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell } from "@/components/ui";
import SalesbotFunnelTabs from "./flow-tabs";
import {
  SEDES,
  type Sede,
  type FlowType,
  type FunnelLeadRow,
  type SedeFlowSummary,
  type PreviousPeriodSummary,
} from "./steps";

export const dynamic = "force-dynamic";

const RANGES = [7, 15, 30];
const FLOWS: FlowType[] = ["cumpleanos", "alquiler_salas"];

export default async function SalesbotsPage({
  searchParams,
}: {
  searchParams: { sede?: string; range?: string };
}) {
  const sede: Sede = (SEDES as string[]).includes(searchParams.sede ?? "")
    ? (searchParams.sede as Sede)
    : "caracas";
  const range = parseInt(searchParams.range ?? "15", 10);
  const validRange = RANGES.includes(range) ? range : 15;
  const since = new Date(Date.now() - validRange * 24 * 3600 * 1000).toISOString();
  // Período anterior de igual duración, para el comparativo "vs. período anterior".
  const prevSince = new Date(Date.now() - validRange * 2 * 24 * 3600 * 1000).toISOString();

  const supabase = createSupabaseServerClient();

  const [{ data }, { data: allSedesRaw }, { data: prevRaw }] = await Promise.all([
    supabase
      .from("salesbot_funnel_leads")
      .select(
        "kommo_lead_id, sede, flow_type, contact_name, furthest_step_index, reached_human, kommo_created_at, kommo_updated_at"
      )
      .eq("sede", sede)
      .gte("kommo_created_at", since)
      .order("kommo_created_at", { ascending: false }),
    // Liviano, de TODAS las sedes — solo para el comparativo del selector (punto 3).
    supabase
      .from("salesbot_funnel_leads")
      .select("sede, flow_type, reached_human")
      .gte("kommo_created_at", since),
    // Mismo sede, ventana anterior de igual tamaño — para el punto 2.
    supabase
      .from("salesbot_funnel_leads")
      .select("flow_type, reached_human")
      .eq("sede", sede)
      .gte("kommo_created_at", prevSince)
      .lt("kommo_created_at", since),
  ]);

  const rows = (data ?? []) as FunnelLeadRow[];

  const sedeSummary: SedeFlowSummary[] = [];
  for (const s of SEDES) {
    for (const f of FLOWS) {
      const matching = (allSedesRaw ?? []).filter(
        (r) => r.sede === s && r.flow_type === f
      ) as Array<{ reached_human: boolean }>;
      sedeSummary.push({
        sede: s,
        flow_type: f,
        total: matching.length,
        reached: matching.filter((r) => r.reached_human).length,
      });
    }
  }

  const previousPeriod: PreviousPeriodSummary = {
    cumpleanos: { total: 0, reached: 0 },
    alquiler_salas: { total: 0, reached: 0 },
  };
  for (const r of (prevRaw ?? []) as Array<{ flow_type: FlowType; reached_human: boolean }>) {
    previousPeriod[r.flow_type].total += 1;
    if (r.reached_human) previousPeriod[r.flow_type].reached += 1;
  }

  return (
    <PageShell
      title="Salesbots"
      description="Funnel de los bots de Alquiler de Cumpleaños y Reserva de Salas en Kommo, separado por sede. No se mezclan sedes entre sí — cada una tiene sus propias fallas y volumen."
      toolbar={
        <div className="flex items-center gap-1.5">
          {RANGES.map((r) => (
            <a
              key={r}
              href={`/salesbots?sede=${sede}&range=${r}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                r === validRange
                  ? "bg-neutral-900 text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
            >
              {r}d
            </a>
          ))}
        </div>
      }
    >
      <SalesbotFunnelTabs
        rows={rows}
        rangeDays={validRange}
        sede={sede}
        sedeSummary={sedeSummary}
        previousPeriod={previousPeriod}
      />
    </PageShell>
  );
}
