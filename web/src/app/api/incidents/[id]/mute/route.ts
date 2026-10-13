import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Silencia la franja de un incidente por 1 hora SIN cerrarlo.
 *
 * Deliberadamente no hay "descartar": el incidente lo cierra `health-scan`
 * cuando la salud vuelve de verdad. Si un humano pudiera cerrarlo a mano, la
 * franja se apagaría con el sistema todavía roto — que es exactamente el
 * agujero que este feature vino a tapar.
 */
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const hasta = new Date(Date.now() + 3600_000).toISOString();
  const { error } = await supabase
    .from("system_incidents")
    .update({ muted_until: hasta, muted_by: user.id })
    .eq("id", params.id)
    .is("resolved_at", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, muted_until: hasta });
}
