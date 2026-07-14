import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const slug = String(body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!slug) return NextResponse.json({ error: "slug requerido" }, { status: 400 });

  const { error } = await supabase.from("graders").insert({
    slug,
    name: String(body.name ?? slug),
    description: body.description ?? null,
    prompt: String(body.prompt ?? ""),
    scale: body.scale === "pass_fail" ? "pass_fail" : "numeric_0_1",
    weight: Number(body.weight ?? 1),
    source: ["llm_judge", "automatic", "manual"].includes(body.source) ? body.source : "llm_judge",
    enabled: body.enabled !== false,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
