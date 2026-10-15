import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const GraderBody = z.object({
  slug: z.string().optional(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  prompt: z.string().optional(),
  scale: z.enum(["pass_fail", "numeric_0_1"]).optional(),
  weight: z.union([z.number(), z.string()]).optional(),
  source: z.enum(["llm_judge", "automatic", "manual"]).optional(),
  enabled: z.boolean().optional(),
});

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, GraderBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const slug = (body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!slug) return NextResponse.json({ error: "slug requerido" }, { status: 400 });

  const { error } = await supabase.from("graders").insert({
    slug,
    name: body.name ?? slug,
    description: body.description ?? null,
    prompt: body.prompt ?? "",
    scale: body.scale ?? "numeric_0_1",
    weight: Number(body.weight ?? 1),
    source: body.source ?? "llm_judge",
    enabled: body.enabled !== false,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
