import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchLeadStage } from "@/lib/kommo";

export const dynamic = "force-dynamic";

// Guarda en la base la posición (etapa + pipeline) que Kommo tiene HOY para este
// lead. La llama el cliente cuando la conversación abierta detecta que lo guardado
// quedó atrás (un movimiento hecho en Kommo cuyo webhook todavía no llegó).
//
// Es una escritura explícita (POST), no un efecto de renderizar la página: el GET
// de una conversación no escribe en la base ni registra eventos. El cuerpo NO trae
// la etapa: el servidor la lee de Kommo, así que un cliente no puede fijar una
// posición a gusto. Va por apply_lead_position (0061): respeta el orden de los
// eventos (no pisa una posición más nueva), registra el movimiento solo si se
// aplicó y limpia la marca «no existe en Kommo» (que Kommo conteste es señal de vida).
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: lead } = await supabase
    .from("leads")
    .select("id, kommo_lead_id")
    .eq("id", params.id)
    .maybeSingle();
  if (!lead) return NextResponse.json({ error: "Lead no encontrado." }, { status: 404 });
  if (!lead.kommo_lead_id) return NextResponse.json({ ok: true, outcome: "unlinked" });

  // El instante de la LECTURA, no el de la escritura: lo que Kommo contesta vale a esa hora.
  const readAt = new Date().toISOString();
  const live = await fetchLeadStage(Number(lead.kommo_lead_id));
  if (!live) return NextResponse.json({ ok: true, outcome: "kommo_unavailable" });

  const { data, error } = await createServiceClient().rpc("apply_lead_position", {
    p_lead_id: lead.id,
    p_stage_id: live.statusId,
    p_pipeline_id: live.pipelineId,
    p_at: readAt,
    p_moved_by: "kommo",
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; moved?: boolean } | null;
  return NextResponse.json({ ok: true, outcome: row?.outcome ?? "unknown", moved: row?.moved === true });
}
