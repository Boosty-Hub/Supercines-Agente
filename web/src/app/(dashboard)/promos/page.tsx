import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell } from "@/components/ui";
import PromosSituacionesTabs from "./promos-situaciones-tabs";
import { type Promo } from "./promo-utils";
import { type Situacion } from "./situacion-utils";

export const dynamic = "force-dynamic";

export default async function PromosPage({
  searchParams,
}: {
  searchParams: { tab?: string };
}) {
  const supabase = createSupabaseServerClient();

  const [{ data: rawPromos }, { data: rawSituaciones }] = await Promise.all([
    supabase
      .from("promotions")
      .select("id,name,content,kind,starts_at,ends_at,weekdays,enabled")
      .order("created_at", { ascending: false }),
    supabase
      .from("situations")
      .select("id,title,content,starts_at,ends_at,enabled")
      .order("created_at", { ascending: false }),
  ]);

  const promos = (rawPromos ?? []) as Promo[];
  const situaciones = (rawSituaciones ?? []) as Situacion[];

  const initialTab: "promos" | "situaciones" =
    searchParams.tab === "situaciones" ? "situaciones" : "promos";

  return (
    <PageShell
      title="Promos y situaciones"
      description="Lo que el agente debe saber del mundo real: promos y eventos vigentes, y situaciones puntuales (feriados, emergencias) a tener en cuenta en cada respuesta."
    >
      <PromosSituacionesTabs initialTab={initialTab} promos={promos} situaciones={situaciones} />
    </PageShell>
  );
}
