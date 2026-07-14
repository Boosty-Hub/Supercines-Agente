import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const period = body.period === "weekly" ? "weekly" : "daily";

  // El botón manual siempre corre YA (force), aunque la frecuencia configurada
  // todavía no toque. El cron (trigger_dreams) manda solo {period} → sujeto al
  // due-check por frecuencia.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const res = await fetch(`${supabaseUrl}/functions/v1/dreams-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ period, force: true }),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.ok ? 200 : 500 });
}
