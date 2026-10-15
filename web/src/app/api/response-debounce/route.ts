import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// La ruta coerciona y acota a [0, 600] s.
const DebounceBody = z.object({ seconds: z.union([z.number(), z.string()]) });

// Persiste el debounce (segundos de silencio a esperar antes de responder el
// batch de mensajes seguidos de un lead). 0 = responde al instante.
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, DebounceBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const seconds = Math.min(600, Math.max(0, Math.trunc(Number(body.seconds) || 0)));

  const { error } = await supabase
    .from("kommo_publish_config")
    .update({ response_debounce_seconds: seconds })
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
