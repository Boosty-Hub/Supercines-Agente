import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { callInternalFunction, INTERNAL_401_HINT } from "@/lib/internal-call";
import { parseRetryBody } from "@/lib/follow-up-retry";

export const runtime = "nodejs";
// La sesión CMA del seguimiento tarda; no cortar antes que la Edge Function.
export const maxDuration = 120;

// Reintenta a mano UN intento de seguimiento que quedó en `failed`, desde /seguimiento.
// Delega en la Edge Function follow-up-scan — acá no se duplica ninguna
// lógica de envío ni los gates en vivo contra Kommo.
//
// Es POR INTENTO: el panel manda `{ followUpId, step }` de la fila. follow-up-scan
// (`retryOne`) exige que `step` sea el paso que el lead debe recibir ahora
// (follow_up_step + 1) y que ese intento sea el ÚLTIMO de ese paso para ese lead (la
// base lo verifica al reservar, 0077). Si no, responde 409 con el motivo y acá se
// devuelve 409 tal cual: la persona estaba mirando una fila vieja.
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
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = parseRetryBody(raw);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  const body = parsed.value;

  try {
    // follow-up-scan exige el secreto interno (lib/internal-call.ts); la sesión y el
    // alcance ya se validaron arriba y por el middleware (/api/follow-up).
    const res = await callInternalFunction(
      "follow-up-scan",
      { follow_up_id: body.followUpId, step: body.step, force: body.force, confirm_resend: body.confirmResend },
      { timeoutMs: 120_000 }
    );
    if (res.status === 401) return NextResponse.json({ ok: false, error: INTERNAL_401_HINT }, { status: 503 });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // Conflicto: hubo un intento posterior o el lead ya avanzó. Se pasa el motivo tal cual.
    if (res.status === 409) {
      return NextResponse.json(json ?? { ok: false, conflict: true, skipped: "conflicto" }, { status: 409 });
    }
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `follow-up-scan HTTP ${res.status}`, detail: json },
        { status: 502 }
      );
    }
    // En modo puntual la función devuelve { ok, skipped?, outsideHours?,
    // unconfirmed?, conflict?, status?, error? }. Se pasa tal cual para que la UI muestre el
    // motivo real.
    return NextResponse.json(json ?? { ok: false, error: "respuesta vacía" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
