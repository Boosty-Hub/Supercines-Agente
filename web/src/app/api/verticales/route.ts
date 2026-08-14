import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** "" y espacios en blanco valen NULL: un campo vacío no debe escribirse en Kommo. */
function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const slug = String(body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!slug) return NextResponse.json({ error: "slug requerido" }, { status: 400 });

  const { error } = await supabase.from("verticals").insert({
    slug,
    name: String(body.name ?? slug),
    description: body.description ?? null,
    system_prompt: String(body.system_prompt ?? ""),
    auto_reply: body.auto_reply === true,
    requires_review: body.requires_review === true,
    ignore: body.ignore === true,
    // Ruteo al equipo comercial (0052)
    auto_assign: body.auto_assign === true,
    kommo_field_name: strOrNull(body.kommo_field_name),
    kommo_field_value: strOrNull(body.kommo_field_value),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
