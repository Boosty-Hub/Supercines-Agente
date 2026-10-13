import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// "Sincronizar con Kommo": dispara la Edge Function sync-pipelines (refresca
// pipelines/etapas y avanza el backfill de pipeline/etapa de los leads). Es lo
// mismo que hace el cron cada 10 min; el botón evita la espera cuando acaba de
// cambiar algo en Kommo (una etapa nueva, un pipeline renombrado).
//
// La función exige el secreto interno (x-internal-secret, _app_secrets 0065). Se
// lee ACÁ, en el servidor, con la service key, y nunca llega al navegador. La
// sesión se valida con getUser() y el alcance (operacion) lo exige el middleware
// sobre el prefijo /api/inbox (roles.ts).
//
// GET devuelve el estado del backfill para que el tablero avise si todavía hay
// leads sin ubicar (kommo_backfill, 0065).
export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("kommo_backfill")
    .select("status, scanned, updated, last_error, finished_at")
    .eq("job", "lead_positions")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ backfill: data ?? null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  try {
    const { data: secret } = await createServiceClient()
      .from("_app_secrets")
      .select("valor")
      .eq("clave", "INTERNAL_FUNCTION_SECRET")
      .maybeSingle();
    if (!secret?.valor) {
      return NextResponse.json(
        { error: "Falta el secreto interno: aplicá las migraciones pendientes (0065)." },
        { status: 503 }
      );
    }
    const res = await fetch(`${supabaseUrl}/functions/v1/sync-pipelines`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret.valor as string },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: `sync-pipelines respondió ${res.status}. ¿Está deployada la función?` },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: body?.ok === true, pipelines: body?.pipelines ?? null });
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo sincronizar: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
