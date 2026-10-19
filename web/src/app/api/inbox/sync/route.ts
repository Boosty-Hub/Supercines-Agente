import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { callInternalFunction, INTERNAL_401_HINT } from "@/lib/internal-call";
import { configValues } from "@/lib/runtime-config";

export const dynamic = "force-dynamic";

// "Sincronizar con Kommo": dispara la Edge Function sync-pipelines (refresca
// pipelines/etapas y avanza el backfill de pipeline/etapa de los leads). Es lo
// mismo que hace el cron cada 10 min; el botón evita la espera cuando acaba de
// cambiar algo en Kommo (una etapa nueva, un pipeline renombrado).
//
// La función exige el secreto interno (x-internal-secret, _app_secrets 0061). Se
// lee en el servidor (lib/internal-call.ts) y nunca llega al navegador. La
// sesión se valida con getUser() y el alcance (operacion) lo exige el middleware
// sobre el prefijo /api/inbox (roles.ts).
//
// «Sincronizar» es una PETICIÓN, no una orden: el reinicio completo del recorrido
// de leads lo concede la base (claim_kommo_backfill, 0061) y solo si el recorrido
// terminó y pasó el enfriamiento; uno en curso se retoma sin retroceder. Por eso
// ni clics repetidos ni varias pestañas ni un usuario con scope `operacion`
// pueden mantener un recrawl de Kommo. Esta ruta solo traduce la respuesta.
//
// GET devuelve el estado del backfill para que el tablero avise del progreso y
// deshabilite el botón durante el enfriamiento (kommo_backfill, 0061).

/**
 * Solo para el aviso del botón; la autoridad es claim_kommo_backfill, que recibe
 * el mismo valor desde la Edge Function (RESTART_COOLDOWN_SECONDS en
 * supabase/functions/sync-pipelines/index.ts). Mantenerlos iguales.
 */
const RESTART_COOLDOWN_SECONDS = 15 * 60;

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("kommo_backfill")
    .select("status, scanned, updated, last_error, finished_at, updated_at, lease_until")
    .eq("job", "lead_positions")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ backfill: null }, { headers: { "Cache-Control": "no-store" } });

  const now = Date.now();
  // Un lease sobre un recorrido 'done' es la verificación de borrados en Kommo (0084), no un
  // recorrido: no deshabilita «Sincronizar» (el refresco de pipelines corre igual).
  const running = data.status !== "done" && data.lease_until != null && Date.parse(data.lease_until as string) > now;
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
  const auth = await requireScope("operacion");
  if (!auth.ok) return auth.response;

  // Sin Kommo conectado no hay nada que sincronizar: no es un error del sistema ni
  // de las migraciones, y la UI lo dice con su propio mensaje.
  const { KOMMO_API_DOMAIN: domain, KOMMO_ACCESS_TOKEN: token } = await configValues([
    "KOMMO_API_DOMAIN",
    "KOMMO_ACCESS_TOKEN",
  ]);
  if (!domain || !token) {
    return NextResponse.json({ ok: true, pipelines: null, backfill: { state: "kommo_not_configured", retry_after_seconds: null } });
  }

  try {
    // pide reconciliar todos los leads; la base decide si corresponde (enfriamiento)
    const res = await callInternalFunction("sync-pipelines", { restart: true });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return NextResponse.json({ error: INTERNAL_401_HINT }, { status: 503 });
    if (!res.ok) {
      return NextResponse.json(
        { error: `sync-pipelines respondió ${res.status}. ¿Está deployada la función?` },
        { status: 502 }
      );
    }
    // state: started | continuing | busy | cooldown | idle | unavailable |
    // kommo_not_configured (ver _shared/backfill-claim.ts). Solo estado y segundos.
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
