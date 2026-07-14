import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("follow_up_templates")
    .select("id, name, description, body, variables, salesbot_id, enabled, created_at, updated_at")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, templates: data ?? [] });
}

export async function POST(request: Request) {
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

  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name requerido" }, { status: 400 });

  const templateBody = String(body.body ?? "").trim();
  if (!templateBody) return NextResponse.json({ error: "body requerido" }, { status: 400 });

  // Warnings (no-blocking) en la respuesta para el dashboard
  const warnings: string[] = [];
  if (!body.salesbot_id) warnings.push("salesbot_id no configurado — la plantilla no puede enviarse hasta mapearlo.");
  const variables = Array.isArray(body.variables) ? body.variables : [];
  for (const v of variables as Array<Record<string, unknown>>) {
    // Se considera "mapeada" si tiene un campo de Kommo directo (kommo_field_id);
    // field_id es el shape legacy (tabla follow_up_fields) que el edge resuelve por compat.
    if (!v.kommo_field_id && !v.field_id) {
      warnings.push(`Variable "${v.name}" sin campo de Kommo — la plantilla no podrá enviarse hasta asignarle uno.`);
    }
  }

  const { data, error } = await supabase
    .from("follow_up_templates")
    .insert({
      name,
      description: body.description ? String(body.description) : null,
      body: templateBody,
      variables: variables,
      salesbot_id: body.salesbot_id ? Number(body.salesbot_id) : null,
      enabled: body.enabled !== false,
    })
    .select("id, name, description, body, variables, salesbot_id, enabled, created_at, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Pocos clicks: si viene delay_hours, agregamos esta plantilla a la secuencia
  // como un paso nuevo (step_number = siguiente disponible), sin pisar los pasos
  // existentes. La IA sugiere el delay; el operador lo puede ajustar después.
  let step = null;
  const delayHours = Number(body.delay_hours);
  if (Number.isFinite(delayHours) && delayHours > 0) {
    const { data: last } = await supabase
      .from("follow_up_steps")
      .select("step_number")
      .order("step_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextStep = (last?.step_number ?? 0) + 1;
    const { data: stepRow, error: stepErr } = await supabase
      .from("follow_up_steps")
      .insert({
        step_number: nextStep,
        delay_hours: Math.round(delayHours),
        template_id: data.id,
        enabled: true,
      })
      .select("id, step_number, delay_hours, template_id, enabled")
      .single();
    if (stepErr) {
      warnings.push(`La plantilla se creó pero no se pudo agregar a la secuencia: ${stepErr.message}`);
    } else {
      step = stepRow;
    }
  }

  return NextResponse.json({ ok: true, template: data, step, warnings });
}
