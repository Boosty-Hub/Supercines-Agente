import { NextResponse } from "next/server";
import { trustedActorName } from "@/lib/auth/actor";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { moveLeadInKommo } from "@/lib/kommo";
import { createServiceClient } from "@/lib/supabase/service";
import { matchesExpected, parseExpected, type ExpectedPosition } from "@/lib/move-position";

export const dynamic = "force-dynamic";

type PipelineRef = { name?: string };

// Mover un lead de etapa desde el panel (tablero kanban / "Mover a…").
//
// Orden: validar → Kommo → base. Kommo es la fuente de verdad: si el PATCH falla
// no se toca nada acá y el tablero devuelve la tarjeta a su columna.
//
// Registro: leads.kommo_stage_id + kommo_pipeline_id y el evento de la línea de
// tiempo, en el mismo paso (apply_lead_position, 0061).
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let stageId: number;
  let pipelineId: number;
  let expected: ExpectedPosition | undefined;
  try {
    const body = await request.json();
    stageId = Number(body?.stage_id);
    pipelineId = Number(body?.pipeline_id);
    const parsed = parseExpected(body?.expected);
    if (parsed === null) return NextResponse.json({ error: "expected inválido." }, { status: 400 });
    expected = parsed;
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

  // Serialización optimista: el cliente dice desde qué posición mueve. Si la real es otra,
  // otro movimiento (de este panel o de Kommo) llegó en el medio y este es obsoleto:
  // 409 con la posición vigente para que el cliente reencole sobre ella (ver
  // lib/move-queue.ts). Va DESPUÉS del "sin cambios" para que reintentar un movimiento
  // que ya se aplicó siga siendo idempotente.
  if (!matchesExpected(expected, { pipeline_id: prevPipeline, stage_id: prevStage })) {
    return NextResponse.json(
      {
        error: "El lead cambió de etapa mientras tanto.",
        code: "position_changed",
        current: { pipeline_id: prevPipeline, stage_id: prevStage },
      },
      { status: 409 }
    );
  }

  const moved = await moveLeadInKommo(Number(lead.kommo_lead_id), stageId, pipelineId);
  if (!moved.ok) return NextResponse.json({ error: moved.error }, { status: moved.status });

  // Kommo ya lo movió: de acá en más, un fallo en la base no se le muestra como
  // error al usuario (el webhook de Kommo igual va a actualizar la etapa).
  const embedded = stage.kommo_pipelines as unknown as PipelineRef | PipelineRef[] | null;
  const pipelineName = (Array.isArray(embedded) ? embedded[0]?.name : embedded?.name) ?? null;
  // Autoría de AUDITORÍA: id de auth + nombre de fuentes que el usuario no controla.
  // user_metadata lo edita el propio usuario (auth.updateUser) y permitía suplantar a otro.
  const who = trustedActorName(user);

  // La posición se escribe por apply_lead_position (0061), que solo ejecuta
  // service_role: este handler ya validó la sesión y el alcance. Fija etapa +
  // pipeline y registra el evento en un solo paso; Kommo manda leads.status de
  // vuelta por este movimiento y la base lo descarta como eco (llegue antes o
  // después), sin duplicarlo ni retroceder la etapa.
  const { error: posErr } = await createServiceClient().rpc("apply_lead_position", {
    p_lead_id: lead.id,
    p_stage_id: stageId,
    p_pipeline_id: pipelineId,
    p_at: new Date().toISOString(),
    p_moved_by: "kommo",
    p_actor_name: `${who} (desde el panel)`,
    p_actor_user_id: user.id,
    p_to_stage_name: stage.name,
    p_pipeline_name: pipelineName,
  });
  return NextResponse.json({
    ok: true,
    warning: posErr ? `Movido en Kommo, pero no se pudo registrar acá: ${posErr.message}` : undefined,
  });
}
