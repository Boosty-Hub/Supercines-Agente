import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  fetch(`${supabaseUrl}/functions/v1/publish-to-kommo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
