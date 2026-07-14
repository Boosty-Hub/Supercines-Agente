import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Resuelve un mensaje marcado para revisión humana: limpia el flag y dispara
// al agente en modo force_review (el draft queda 'pending' para que el humano
// lo apruebe o edite en la misma conversación).
export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("messages")
    .update({ requires_human_review: false })
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  fetch(`${supabaseUrl}/functions/v1/generate-response`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message_id: params.id, force_review: true }),
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
