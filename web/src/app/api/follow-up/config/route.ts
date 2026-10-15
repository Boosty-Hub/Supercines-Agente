import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// La ruta coerciona con Number(): se aceptan número o string (y null, que el panel manda cuando
// no hay días activos: Math.min() vacío → Infinity → null en JSON).
const NumberLike = z.union([z.number(), z.string(), z.null()]);
const IdList = z.array(z.union([z.number(), z.string()])).nullable();
const FollowUpConfigBody = z.object({
  enabled: z.boolean().optional(),
  timezone: z.string().optional(),
  business_hours_start: NumberLike.optional(),
  business_hours_end: NumberLike.optional(),
  active_days: z.array(z.number().int()).optional(),
  business_hours: z.record(z.unknown()).nullable().optional(),
  max_follow_ups: NumberLike.optional(),
  min_gap_hours: NumberLike.optional(),
  run_stage_ids: IdList.optional(),
  run_user_ids: IdList.optional(),
  notes: z.string().nullable().optional(),
});

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("follow_up_config")
    .select(
      "id, enabled, timezone, business_hours, business_hours_start, business_hours_end, active_days, max_follow_ups, min_gap_hours, run_stage_ids, run_user_ids, notes, updated_at"
    )
    .eq("is_active", true)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, config: data });
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, FollowUpConfigBody);
  if (!input.ok) return input.response;
  const body = input.data;

  // Construir el patch — solo los campos presentes en el body
  const patch: Record<string, unknown> = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled === true;
  if (body.timezone !== undefined) patch.timezone = body.timezone.trim();
  if (body.business_hours_start !== undefined) patch.business_hours_start = Number(body.business_hours_start);
  if (body.business_hours_end !== undefined) patch.business_hours_end = Number(body.business_hours_end);
  if (body.active_days !== undefined) patch.active_days = body.active_days;
  if (body.business_hours !== undefined) {
    // Horario por día: { "1": {start:"09:00", end:"21:00"}, ... } o null.
    if (body.business_hours === null) {
      patch.business_hours = null;
    } else {
      const HHMM = /^\d{2}:\d{2}$/;
      const clean: Record<string, { start: string; end: string }> = {};
      for (const [day, range] of Object.entries(body.business_hours)) {
        const d = Number(day);
        const r = range as { start?: unknown; end?: unknown };
        if (
          Number.isInteger(d) && d >= 1 && d <= 7 &&
          typeof r?.start === "string" && HHMM.test(r.start) &&
          typeof r?.end === "string" && HHMM.test(r.end) &&
          r.start < r.end
        ) {
          clean[String(d)] = { start: r.start, end: r.end };
        } else {
          return NextResponse.json(
            { error: `business_hours inválido en día "${day}" (esperado {start:"HH:MM", end:"HH:MM"} con start < end)` },
            { status: 400 }
          );
        }
      }
      patch.business_hours = Object.keys(clean).length > 0 ? clean : null;
    }
  }
  if (body.max_follow_ups !== undefined) patch.max_follow_ups = Number(body.max_follow_ups);
  if (body.min_gap_hours !== undefined) patch.min_gap_hours = Number(body.min_gap_hours);
  // run_stage_ids: lista blanca de etapas de Kommo. Saneamos a enteros > 0 únicos.
  if (body.run_stage_ids !== undefined) {
    patch.run_stage_ids = Array.isArray(body.run_stage_ids)
      ? Array.from(
          new Set(
            body.run_stage_ids
              .map(Number)
              .filter((n) => Number.isFinite(n) && n > 0)
          )
        )
      : [];
  }
  // run_user_ids: lista blanca de responsables (vendedores). Mismo saneo.
  if (body.run_user_ids !== undefined) {
    patch.run_user_ids = Array.isArray(body.run_user_ids)
      ? Array.from(
          new Set(
            body.run_user_ids
              .map(Number)
              .filter((n) => Number.isFinite(n) && n > 0)
          )
        )
      : [];
  }
  if (body.notes !== undefined) patch.notes = body.notes || null;

  // Upsert el singleton is_active=true
  // Primero intentar update; si no existe, insert.
  const { data: existing } = await supabase
    .from("follow_up_config")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  let result;
  if (existing) {
    result = await supabase
      .from("follow_up_config")
      .update(patch)
      .eq("id", existing.id)
      .select("id, enabled, timezone, business_hours, business_hours_start, business_hours_end, active_days, max_follow_ups, min_gap_hours, run_stage_ids, run_user_ids, notes, updated_at")
      .single();
  } else {
    result = await supabase
      .from("follow_up_config")
      .insert({ ...patch, is_active: true })
      .select("id, enabled, timezone, business_hours, business_hours_start, business_hours_end, active_days, max_follow_ups, min_gap_hours, run_stage_ids, run_user_ids, notes, updated_at")
      .single();
  }

  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, config: result.data });
}
