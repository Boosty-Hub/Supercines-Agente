import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const VerticalsBody = z.object({
  verticals: z.array(
    z.object({
      slug: z.string().optional(),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      system_prompt: z.string().optional(),
      auto_reply: z.boolean().optional(),
      requires_review: z.boolean().optional(),
    })
  ),
});

export const runtime = "nodejs";

// Bulk-save the verticals the user accepted in the wizard. Upsert by slug so
// re-running the step (or accepting on top of the seeded generics) never errors
// on duplicates — existing rows are updated, new ones inserted.
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, VerticalsBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const list = body.verticals;
  const rows = list
    .map((v) => {
      const slug = String(v.slug ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_");
      if (!slug) return null;
      return {
        slug,
        name: String(v.name ?? slug),
        description: v.description != null ? String(v.description) : null,
        system_prompt: String(v.system_prompt ?? ""),
        auto_reply: v.auto_reply === true,
        requires_review: v.requires_review === true,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, saved: 0 });
  }

  const { error } = await supabase
    .from("verticals")
    .upsert(rows, { onConflict: "slug" });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, saved: rows.length });
}
