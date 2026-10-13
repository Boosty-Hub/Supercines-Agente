import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { callInternalFunction, INTERNAL_401_HINT } from "@/lib/internal-call";

export const runtime = "nodejs";
// La sesión CMA del seguimiento tarda; no cortar antes que la Edge Function.
export const maxDuration = 120;

// Reintenta a mano UN seguimiento que quedó en `failed`, desde /seguimiento.
// Delega en la Edge Function follow-up-scan — acá no se duplica ninguna
// lógica de envío ni los gates en vivo contra Kommo.
//
// El modo puntual EXISTE en la Edge Function: `follow-up-scan` lee
// `{ lead_id, force }` del body y procesa ESE lead con su propio gate
// (`retryOne`), sin pasar por la RPC del barrido. Sin body, hace el barrido
// automático de siempre — ese camino no cambió.
//
// `force` saltea el horario laboral, y sólo eso: un reintento manual lo pide
// una persona que está mirando la conversación, así que el horario deja de ser
// una protección y pasa a ser un estorbo. Los demás gates (opt-out, estado
// terminal, tope de envíos, etapa fuera del whitelist en vivo) NO se saltean.
//
// `confirmResend` lo manda la UI SOLO tras confirmar en un diálogo que el intento
// anterior pudo haberle llegado («sin confirmar»). Sin él, la reserva por lead y paso
// (0072) no deja reenviar ese paso. Nunca permite enviar un paso ya enviado ni
// pisar un envío en curso del barrido.
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { leadId?: unknown; force?: unknown; confirmResend?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";
  if (!leadId) {
    return NextResponse.json({ ok: false, error: "falta leadId" }, { status: 400 });
  }

  try {
    // follow-up-scan exige el secreto interno (lib/internal-call.ts); la sesión y el
    // alcance ya se validaron arriba y por el middleware (/api/follow-up).
    const res = await callInternalFunction(
      "follow-up-scan",
      { lead_id: leadId, force: body.force === true, confirm_resend: body.confirmResend === true },
      { timeoutMs: 120_000 }
    );
    if (res.status === 401) return NextResponse.json({ ok: false, error: INTERNAL_401_HINT }, { status: 503 });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `follow-up-scan HTTP ${res.status}`, detail: json },
        { status: 502 }
      );
    }
    // En modo puntual la función devuelve { ok, skipped?, outsideHours?,
    // unconfirmed?, status?, error? }. Se pasa tal cual para que la UI muestre el
    // motivo real.
    return NextResponse.json(json ?? { ok: false, error: "respuesta vacía" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
