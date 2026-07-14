import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("follow_up_fields")
    .select("id, label, kommo_field_id, created_at")
    .order("label");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, fields: data ?? [] });
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

  const label = String(body.label ?? "").trim();
  if (!label) return NextResponse.json({ error: "label requerido" }, { status: 400 });

  const kommoFieldId = Number(body.kommo_field_id);
  if (!Number.isFinite(kommoFieldId) || kommoFieldId <= 0) {
    return NextResponse.json({ error: "kommo_field_id inválido" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("follow_up_fields")
    .insert({ label, kommo_field_id: kommoFieldId })
    .select("id, label, kommo_field_id, created_at")
    .single();
  if (error) {
    // Unique constraint violation (kommo_field_id duplicate)
    if (error.code === "23505") {
      return NextResponse.json(
        { error: `Ya existe un campo con kommo_field_id=${kommoFieldId}.` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, field: data });
}
