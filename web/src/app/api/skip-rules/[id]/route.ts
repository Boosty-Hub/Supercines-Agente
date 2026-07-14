import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const MATCH_TYPES = ["contains", "regex", "mention_tag"];

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
  if (typeof body.pattern === "string") update.pattern = body.pattern.trim();
  if (typeof body.match_type === "string" && MATCH_TYPES.includes(body.match_type))
    update.match_type = body.match_type;
  if (typeof body.case_sensitive === "boolean") update.case_sensitive = body.case_sensitive;
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;
  if (typeof body.description === "string")
    update.description = body.description.trim() || null;

  // Validaciones: regex válida y patrón requerido salvo en mention_tag.
  const effectiveType = (update.match_type as string) ?? undefined;
  if (effectiveType === "regex" && typeof update.pattern === "string") {
    try {
      new RegExp(update.pattern as string);
    } catch {
      return NextResponse.json({ error: "Expresión regular inválida." }, { status: 400 });
    }
  }
  if (
    effectiveType &&
    effectiveType !== "mention_tag" &&
    typeof update.pattern === "string" &&
    !(update.pattern as string)
  ) {
    return NextResponse.json(
      { error: "El patrón es requerido para este tipo de regla." },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("agent_skip_rules")
    .update(update)
    .eq("id", params.id);
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

  const { error } = await supabase.from("agent_skip_rules").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
