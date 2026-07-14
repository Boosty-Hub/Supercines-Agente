import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type VerticalInput = {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  system_prompt?: unknown;
  auto_reply?: unknown;
  requires_review?: unknown;
};

// Bulk-save the verticals the user accepted in the wizard. Upsert by slug so
// re-running the step (or accepting on top of the seeded generics) never errors
// on duplicates — existing rows are updated, new ones inserted.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { verticals?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const list = Array.isArray(body.verticals) ? (body.verticals as VerticalInput[]) : [];
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
