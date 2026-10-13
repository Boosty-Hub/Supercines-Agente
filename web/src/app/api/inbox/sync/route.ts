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
// «Sincronizar» es una PETICIÓN, no una orden: el reinicio completo del recorrido
// de leads lo concede la base (claim_kommo_backfill, 0065) y solo si el recorrido
// terminó y pasó el enfriamiento; uno en curso se retoma sin retroceder. Por eso
// ni clics repetidos ni varias pestañas ni un usuario con scope `operacion`
// pueden mantener un recrawl de Kommo. Esta ruta solo traduce la respuesta.
//
// GET devuelve el estado del backfill para que el tablero avise del progreso y
// deshabilite el botón durante el enfriamiento (kommo_backfill, 0065).

/**
 * Solo para el aviso del botón; la autoridad es claim_kommo_backfill, que recibe
 * el mismo valor desde la Edge Function (RESTART_COOLDOWN_SECONDS en
 * supabase/functions/sync-pipelines/index.ts). Mantenerlos iguales.
 */
const RESTART_COOLDOWN_SECONDS = 15 * 60;

export async function GET() {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("kommo_backfill")
    .select("status, scanned, updated, last_error, finished_at, updated_at, lease_until")
    .eq("job", "lead_positions")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ backfill: null }, { headers: { "Cache-Control": "no-store" } });

  const now = Date.now();
  const running = data.lease_until != null && Date.parse(data.lease_until as string) > now;
  const inProgress = running || data.status === "pending" || data.status === "running";
  const retryAfter =
    data.status === "done"
      ? Math.max(0, Math.ceil((Date.parse(data.updated_at as string) + RESTART_COOLDOWN_SECONDS * 1000 - now) / 1000))
      : 0;
  return NextResponse.json(
    {
      backfill: {
        status: data.status,
        scanned: data.scanned,
        updated: data.updated,
        last_error: data.last_error,
        finished_at: data.finished_at,
        in_progress: inProgress,
        retry_after_seconds: retryAfter,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
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
      body: JSON.stringify({ restart: true }), // pide reconciliar todos los leads; la base decide si corresponde
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
    // state: started | continuing | busy | cooldown | idle | unavailable (ver
    // _shared/backfill-claim.ts). Nada de secretos: solo estado y segundos.
    const state = typeof body?.backfill?.state === "string" ? (body.backfill.state as string) : "unavailable";
    const retry = Number(body?.backfill?.retry_after_seconds);
    return NextResponse.json({
      ok: body?.ok === true,
      pipelines: body?.pipelines ?? null,
      backfill: { state, retry_after_seconds: Number.isFinite(retry) && retry > 0 ? retry : null },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `No se pudo sincronizar: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
