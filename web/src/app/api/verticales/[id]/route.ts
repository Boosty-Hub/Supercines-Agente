import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const update: Record<string, unknown> = {};
  if (typeof body.name === "string") update.name = body.name;
  if (typeof body.description === "string") update.description = body.description;
  if (typeof body.system_prompt === "string") update.system_prompt = body.system_prompt;
  if (typeof body.auto_reply === "boolean") update.auto_reply = body.auto_reply;
  if (typeof body.requires_review === "boolean") update.requires_review = body.requires_review;
  if (typeof body.ignore === "boolean") update.ignore = body.ignore;
  // Ruteo al equipo comercial (0052). Los campos de Kommo aceptan "" como
  // "borrar la config" → se guardan NULL, que es lo que lee la Edge Function.
  if (typeof body.auto_assign === "boolean") update.auto_assign = body.auto_assign;
  if (typeof body.kommo_field_name === "string") {
    update.kommo_field_name = body.kommo_field_name.trim() || null;
  }
  if (typeof body.kommo_field_value === "string") {
    update.kommo_field_value = body.kommo_field_value.trim() || null;
  }

  const { error } = await supabase.from("verticals").update(update).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase.from("verticals").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
