import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { callInternalFunction } from "@/lib/internal-call";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: string | undefined;
  try {
    const json = await request.json();
    if (typeof json?.body === "string" && json.body.trim()) body = json.body.trim();
  } catch {
    // sin body es OK
  }

  const update: Record<string, unknown> = {
    status: "approved",
    reviewer_id: user.id,
  };
  if (body) update.edited_body = body;

  const { error } = await supabase
    .from("drafts")
    .update(update)
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Disparar publish (no esperar)
  callInternalFunction("publish-to-kommo", {}).catch(() => {});

  return NextResponse.json({ ok: true });
}
