import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const SkipRulePatchBody = z.object({
  pattern: z.string().optional(),
  match_type: z.enum(["contains", "regex", "mention_tag"]).optional(),
  case_sensitive: z.boolean().optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
});

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, SkipRulePatchBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const update: Record<string, unknown> = {};
  if (body.pattern !== undefined) update.pattern = body.pattern.trim();
  if (body.match_type !== undefined) update.match_type = body.match_type;
  if (body.case_sensitive !== undefined) update.case_sensitive = body.case_sensitive;
  if (body.enabled !== undefined) update.enabled = body.enabled;
  if (body.description !== undefined) update.description = body.description.trim() || null;

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

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase.from("agent_skip_rules").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
