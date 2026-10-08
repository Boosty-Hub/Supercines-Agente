import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell } from "@/components/ui";
import SalesbotFunnelTabs from "./flow-tabs";
import { SEDES, SEDE_LABELS, type Sede, type FunnelLeadRow } from "./steps";

export const dynamic = "force-dynamic";

const RANGES = [7, 15, 30];

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

  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from("salesbot_funnel_leads")
    .select("kommo_lead_id, sede, flow_type, contact_name, furthest_step_index, reached_human, kommo_created_at, kommo_updated_at")
    .eq("sede", sede)
    .gte("kommo_created_at", since)
    .order("kommo_created_at", { ascending: false });

  const rows = (data ?? []) as FunnelLeadRow[];

  return (
    <PageShell
      title="Salesbots"
      description="Funnel de los bots de Alquiler de Cumpleaños y Reserva de Salas en Kommo, separado por sede. No se mezclan sedes entre sí — cada una tiene sus propias fallas y volumen."
      toolbar={
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            {SEDES.map((s) => (
              <a
                key={s}
                href={`/salesbots?sede=${s}&range=${validRange}`}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  s === sede
                    ? "bg-neutral-900 text-white"
                    : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                }`}
              >
                {SEDE_LABELS[s]}
              </a>
            ))}
          </div>
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
        </div>
      }
    >
      <SalesbotFunnelTabs rows={rows} rangeDays={validRange} />
    </PageShell>
  );
}
