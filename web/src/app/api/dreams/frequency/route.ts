import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { setConfigValues } from "@/lib/runtime-config";

const FREQUENCIES = ["daily", "3d", "7d", "15d"] as const;

// Frecuencia del análisis nocturno de Dreams (runtime_config DREAMS_FREQUENCY):
//   daily → todos los días · 3d → cada 3 días · 7d → cada 7 · 15d → cada 15.
// El cron sigue disparando a diario; dreams-run hace un due-check y saltea si
// todavía no toca (según DREAMS_LAST_RUN).
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { frequency?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const frequency = String(body.frequency ?? "");
  if (!FREQUENCIES.includes(frequency as (typeof FREQUENCIES)[number])) {
    return NextResponse.json(
      { error: `frequency debe ser uno de: ${FREQUENCIES.join(", ")}` },
      { status: 400 }
    );
  }

  await setConfigValues({ DREAMS_FREQUENCY: frequency }, user.email ?? "dashboard");
  return NextResponse.json({ ok: true, frequency });
}
