import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { moveLeadInKommo } from "@/lib/kommo";

export const dynamic = "force-dynamic";

type PipelineRef = { name?: string };

// Mover un lead de etapa desde el panel (tablero kanban / "Mover a…").
//
// Orden: validar → Kommo → base. Kommo es la fuente de verdad: si el PATCH falla
// no se toca nada acá y el tablero devuelve la tarjeta a su columna.
//
// Registro: leads.kommo_stage_id + kommo_pipeline_id y el evento de la línea de
// tiempo se escriben en el mismo paso (record_lead_stage_event, 0065). Kommo
// manda leads.status de vuelta por este movimiento: la base lo reconoce como el
// mismo (misma etapa y pipeline) y NO crea un segundo evento, llegue antes o
// después de este handler.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let stageId: number;
  let pipelineId: number;
  try {
    const body = await request.json();
    stageId = Number(body?.stage_id);
    pipelineId = Number(body?.pipeline_id);
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido." }, { status: 400 });
  }
  if (!Number.isFinite(stageId) || !Number.isFinite(pipelineId)) {
    return NextResponse.json({ error: "Faltan stage_id y pipeline_id." }, { status: 400 });
  }

  const [{ data: lead }, { data: stage }] = await Promise.all([
    supabase
      .from("leads")
      .select("id, kommo_lead_id, kommo_stage_id, kommo_pipeline_id")
      .eq("id", params.id)
      .maybeSingle(),
    supabase
      .from("kommo_stages")
      .select("id, name, pipeline_id, kommo_pipelines(name)")
      .eq("pipeline_id", pipelineId)
      .eq("id", stageId)
      .maybeSingle(),
  ]);
  if (!lead) return NextResponse.json({ error: "Lead no encontrado." }, { status: 404 });
  if (!lead.kommo_lead_id) {
    return NextResponse.json({ error: "El lead no está vinculado a Kommo." }, { status: 409 });
  }
  if (!stage) return NextResponse.json({ error: "Esa etapa no existe en ese pipeline." }, { status: 400 });

  const prevStage = lead.kommo_stage_id as number | null;
  const prevPipeline = lead.kommo_pipeline_id as number | null;
  if (prevStage === stageId && prevPipeline === pipelineId) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  const moved = await moveLeadInKommo(Number(lead.kommo_lead_id), stageId, pipelineId);
  if (!moved.ok) return NextResponse.json({ error: moved.error }, { status: moved.status });

  // Kommo ya lo movió: de acá en más, un fallo en la base no se le muestra como
  // error al usuario (el webhook de Kommo igual va a actualizar la etapa).
  const embedded = stage.kommo_pipelines as unknown as PipelineRef | PipelineRef[] | null;
  const pipelineName = (Array.isArray(embedded) ? embedded[0]?.name : embedded?.name) ?? null;
  const meta = user.user_metadata as { full_name?: string; name?: string } | null;
  const who = meta?.full_name ?? meta?.name ?? user.email ?? "usuario";

  const upd = await supabase
    .from("leads")
    .update({ kommo_stage_id: stageId, kommo_pipeline_id: pipelineId, kommo_missing_at: null }) // Kommo aceptó el PATCH: el lead existe
    .eq("id", lead.id);
  const ev = await supabase.rpc("record_lead_stage_event", {
    p_lead_id: lead.id,
    p_from_stage_id: prevStage,
    p_from_pipeline_id: prevPipeline,
    p_to_stage_id: stageId,
    p_to_pipeline_id: pipelineId,
    p_from_stage_name: null, // la línea de tiempo lo resuelve con kommo_stages
    p_to_stage_name: stage.name,
    p_pipeline_name: pipelineName,
    p_moved_by: "kommo",
    p_draft_id: null,
    p_actor_name: `${who} (desde el panel)`,
  });
  const failure = upd.error ?? ev.error;
  return NextResponse.json({
    ok: true,
    warning: failure ? `Movido en Kommo, pero no se pudo registrar acá: ${failure.message}` : undefined,
  });
}
