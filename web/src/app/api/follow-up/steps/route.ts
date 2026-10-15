import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// La secuencia COMPLETA (reemplaza los pasos existentes). Sin `steps` es 400: antes un body
// sin la lista borraba la secuencia entera.
const StepsBody = z.object({
  steps: z.array(
    z.object({
      step_number: z.union([z.number(), z.string()]).optional(),
      delay_hours: z.union([z.number(), z.string()]).optional(),
      template_id: z.union([z.string(), z.number(), z.null()]).optional(),
      enabled: z.boolean().optional(),
    })
  ),
});

export async function GET() {
  const supabase = await createSupabaseServerClient();
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
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, StepsBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const { steps } = body;

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
