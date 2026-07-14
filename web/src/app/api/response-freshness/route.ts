import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Persiste la ventana de frescura: el agente solo atiende mensajes de las
// últimas N horas. Lo más viejo se ignora (lo manejan los asesores). 0 = sin
// límite (atiende todo el backlog). Evita arrastrar cola vieja tras una caída.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const hours = Math.min(168, Math.max(0, Math.trunc(Number(body.hours) || 0)));

  const { error } = await supabase
    .from("kommo_publish_config")
    .update({ answer_max_age_hours: hours })
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
