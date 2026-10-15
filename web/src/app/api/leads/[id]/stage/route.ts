import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { trustedActorName } from "@/lib/auth/actor";
import { moveLeadInKommo } from "@/lib/kommo";
import { createServiceClient } from "@/lib/supabase/service";
import { parseExpected } from "@/lib/move-position";
import { MOVE_CLAIM_TTL_SECONDS } from "@/lib/move-claim";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// stage_id/pipeline_id: la ruta coerciona con Number(); expected lo valida parseExpected.
const StageBody = z.object({
  stage_id: z.union([z.number(), z.string()]).optional(),
  pipeline_id: z.union([z.number(), z.string()]).optional(),
  expected: z.unknown().optional(),
});

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
  const auth = await requireScope("operacion");
  if (!auth.ok) return auth.response;
  const { supabase, user } = auth;

  const input = await readJson(request, StageBody);
  if (!input.ok) return input.response;
  const stageId = Number(input.data.stage_id);
  const pipelineId = Number(input.data.pipeline_id);
  const expected = parseExpected(input.data.expected);
  if (expected === null) return NextResponse.json({ error: "expected inválido." }, { status: 400 });
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

  // Serialización de movimientos del MISMO lead (otra pestaña u otra persona), en la base:
  // claim_lead_move reserva el lead atómicamente (select … for update) y comprueba que la
  // posición vigente sea la que el cliente vio (`expected`). position_changed → 409 con la
  // posición actual para que el cliente reencole (lib/move-queue.ts); busy → hay otro
  // movimiento en vuelo. Va DESPUÉS del "sin cambios" para que reintentar un movimiento ya
  // aplicado siga siendo idempotente. La reserva vence sola (MOVE_CLAIM_TTL_SECONDS, por
  // encima del peor caso de moveLeadInKommo: lib/move-claim.ts) y al terminar se suelta con
  // SU token: si venció y otro movimiento la tomó, el release de éste no borra la ajena.
  const svc = createServiceClient();
  const { data: claimRows, error: claimErr } = await svc.rpc("claim_lead_move", {
    p_lead_id: lead.id,
    p_check_position: expected !== undefined,
    p_expected_stage: expected?.stage_id ?? null,
    p_expected_pipeline: expected?.pipeline_id ?? null,
    p_ttl_seconds: MOVE_CLAIM_TTL_SECONDS,
  });
  if (claimErr) return NextResponse.json({ error: `No se pudo reservar el lead: ${claimErr.message}` }, { status: 500 });
  const claim = (
    claimRows as Array<{ outcome: string; stage_id: number | null; pipeline_id: number | null; token: string | null }> | null
  )?.[0];
  if (!claim || claim.outcome === "missing") return NextResponse.json({ error: "Lead no encontrado." }, { status: 404 });
  if (claim.outcome === "position_changed") {
    return NextResponse.json(
      {
        error: "El lead cambió de etapa mientras tanto.",
        code: "position_changed",
        current: { pipeline_id: claim.pipeline_id, stage_id: claim.stage_id },
      },
      { status: 409 }
    );
  }
  if (claim.outcome === "busy") {
    return NextResponse.json(
      { error: "Ya hay un movimiento de este lead en curso.", code: "move_in_progress" },
      { status: 409 }
    );
  }

  if (claim.outcome !== "claimed" || !claim.token) {
    return NextResponse.json({ error: `Reserva inesperada: ${claim.outcome}` }, { status: 500 });
  }

  try {
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
    const { error: posErr } = await svc.rpc("apply_lead_position", {
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
  } finally {
    // Solo la reserva propia (token). false = venció y otro movimiento la tomó: no se toca.
    const { error: relErr } = await svc.rpc("release_lead_move", { p_lead_id: lead.id, p_token: claim.token });
    if (relErr) console.warn("release_lead_move:", relErr.message);
  }
}
