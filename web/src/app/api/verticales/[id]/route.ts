import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const VerticalPatchBody = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  system_prompt: z.string().optional(),
  auto_reply: z.boolean().optional(),
  requires_review: z.boolean().optional(),
  ignore: z.boolean().optional(),
  // Ruteo al equipo comercial (0052).
  auto_assign: z.boolean().optional(),
  kommo_field_name: z.string().optional(),
  kommo_field_value: z.string().optional(),
});

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, VerticalPatchBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.description !== undefined) update.description = body.description;
  if (body.system_prompt !== undefined) update.system_prompt = body.system_prompt;
  if (body.auto_reply !== undefined) update.auto_reply = body.auto_reply;
  if (body.requires_review !== undefined) update.requires_review = body.requires_review;
  if (body.ignore !== undefined) update.ignore = body.ignore;
  // Ruteo al equipo comercial (0052). Los campos de Kommo aceptan "" como
  // "borrar la config" → se guardan NULL, que es lo que lee la Edge Function.
  if (body.auto_assign !== undefined) update.auto_assign = body.auto_assign;
  if (body.kommo_field_name !== undefined) {
    update.kommo_field_name = body.kommo_field_name.trim() || null;
  }
  if (body.kommo_field_value !== undefined) {
    update.kommo_field_value = body.kommo_field_value.trim() || null;
  }

  const { error } = await supabase.from("verticals").update(update).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase.from("verticals").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
