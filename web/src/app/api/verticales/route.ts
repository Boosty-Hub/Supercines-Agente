import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const VerticalBody = z.object({
  slug: z.string().optional(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  system_prompt: z.string().optional(),
  auto_reply: z.boolean().optional(),
  requires_review: z.boolean().optional(),
  ignore: z.boolean().optional(),
  // Ruteo al equipo comercial (0052).
  auto_assign: z.boolean().optional(),
  kommo_field_name: z.string().nullable().optional(),
  kommo_field_value: z.string().nullable().optional(),
});

/** "" y espacios en blanco valen NULL: un campo vacío no debe escribirse en Kommo. */
function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, VerticalBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const slug = (body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!slug) return NextResponse.json({ error: "slug requerido" }, { status: 400 });

  const { error } = await supabase.from("verticals").insert({
    slug,
    name: body.name ?? slug,
    description: body.description ?? null,
    system_prompt: body.system_prompt ?? "",
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
