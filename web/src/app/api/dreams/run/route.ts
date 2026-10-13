import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { callInternalFunction, INTERNAL_401_HINT } from "@/lib/internal-call";

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const period = body.period === "weekly" ? "weekly" : "daily";

  // El botón manual siempre corre YA (force), aunque la frecuencia configurada
  // todavía no toque. El cron (trigger_dreams) manda solo {period} → sujeto al
  // due-check por frecuencia.
  const res = await callInternalFunction("dreams-run", { period, force: true }, { timeoutMs: 120_000 });
  if (res.status === 401) return NextResponse.json({ error: INTERNAL_401_HINT }, { status: 503 });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.ok ? 200 : 500 });
}
