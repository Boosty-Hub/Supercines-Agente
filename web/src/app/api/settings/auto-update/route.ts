import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { setConfigValues } from "@/lib/runtime-config";

export const runtime = "nodejs";

// Toggle de la actualización automática del sistema (AUTO_UPDATE_ENABLED).
// "0" = apagado; ausente o cualquier otro valor = encendido (default ON).
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  await setConfigValues(
    { AUTO_UPDATE_ENABLED: body.enabled === false ? "0" : "1" },
    user.email ?? "dashboard"
  );
  return NextResponse.json({ ok: true, enabled: body.enabled !== false });
}
