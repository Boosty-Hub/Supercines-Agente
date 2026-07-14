import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Persiste el debounce (segundos de silencio a esperar antes de responder el
// batch de mensajes seguidos de un lead). 0 = responde al instante.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const seconds = Math.min(600, Math.max(0, Math.trunc(Number(body.seconds) || 0)));

  const { error } = await supabase
    .from("kommo_publish_config")
    .update({ response_debounce_seconds: seconds })
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
