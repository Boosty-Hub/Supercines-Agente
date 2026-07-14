import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("follow_up_steps")
    .select("id, step_number, delay_hours, template_id, enabled, created_at, updated_at")
    .order("step_number");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, steps: data ?? [] });
}

// PUT: reemplaza toda la secuencia con el array enviado.
// Elimina los pasos existentes e inserta los nuevos en orden.
export async function PUT(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const steps = Array.isArray(body.steps)
    ? (body.steps as Array<Record<string, unknown>>)
    : [];

  // Validar unicidad de step_number en el payload
  const stepNumbers = steps.map((s) => Number(s.step_number));
  if (new Set(stepNumbers).size !== stepNumbers.length) {
    return NextResponse.json({ error: "step_number debe ser único en la secuencia" }, { status: 400 });
  }

  // Eliminar todos los pasos existentes
  const { error: deleteError } = await supabase
    .from("follow_up_steps")
    .delete()
    .not("id", "is", null); // delete all rows
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  if (steps.length === 0) {
    return NextResponse.json({ ok: true, steps: [] });
  }

  // Insertar los nuevos pasos
  const inserts = steps.map((s, i) => ({
    step_number: Number(s.step_number) || i + 1,
    delay_hours: Number(s.delay_hours) || 24,
    template_id: s.template_id ? String(s.template_id) : null,
    enabled: s.enabled !== false,
  }));

  const { data, error } = await supabase
    .from("follow_up_steps")
    .insert(inserts)
    .select("id, step_number, delay_hours, template_id, enabled");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, steps: data ?? [] });
}
