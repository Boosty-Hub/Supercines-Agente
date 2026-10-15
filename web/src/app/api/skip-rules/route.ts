import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const MATCH_TYPES = ["contains", "regex", "mention_tag"] as const;
type MatchType = (typeof MATCH_TYPES)[number];

const SkipRuleBody = z.object({
  pattern: z.string().optional(),
  match_type: z.enum(MATCH_TYPES).optional(),
  case_sensitive: z.boolean().optional(),
  enabled: z.boolean().optional(),
  description: z.string().nullable().optional(),
});

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, SkipRuleBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const matchType: MatchType = body.match_type ?? "contains";
  const pattern = body.pattern?.trim() ?? "";

  // mention_tag admite patrón vacío (= cualquier @mención); el resto lo requiere.
  if (matchType !== "mention_tag" && !pattern) {
    return NextResponse.json(
      { error: "El patrón es requerido para este tipo de regla." },
      { status: 400 }
    );
  }
  if (matchType === "regex") {
    try {
      new RegExp(pattern);
    } catch {
      return NextResponse.json({ error: "Expresión regular inválida." }, { status: 400 });
    }
  }

  const { error } = await supabase.from("agent_skip_rules").insert({
    pattern,
    match_type: matchType,
    case_sensitive: body.case_sensitive === true,
    enabled: body.enabled !== false,
    description: body.description || null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
