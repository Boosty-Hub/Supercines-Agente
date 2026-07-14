import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Persiste el set de canales (origin de Kommo) que el agente ignora.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const channels = Array.isArray(body.channels)
    ? Array.from(
        new Set(
          body.channels
            .filter((c: unknown): c is string => typeof c === "string")
            .map((c: string) => c.trim().toLowerCase())
            .filter(Boolean)
        )
      )
    : [];

  const { error } = await supabase
    .from("kommo_publish_config")
    .update({ ignored_channels: channels })
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
