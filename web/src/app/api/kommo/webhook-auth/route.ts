import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { createServiceClient } from "@/lib/supabase/service";
import { configValues } from "@/lib/runtime-config";
import { generateWebhookSecret, maskDestination, strictModeBlocker, webhookDestination } from "@/lib/kommo-webhook";
import { applyWebhookDestination } from "@/lib/kommo-webhook-apply";

/**
 * Autenticidad del webhook de Kommo (secreto en la URL). Alcance `configuracion`: lo
 * aplica el middleware (prefijo /api/kommo) y, como la respuesta lleva el SECRETO, se
 * verifica otra vez acá (defensa en profundidad).
 *
 *  GET   → URL completa con el secreto + estado del modo, de la rotación y del último descarte.
 *  POST  → { action: "set_mode", mode, force? } · { action: "apply" } · { action: "rotate" }
 *
 * `set_mode: strict` responde 409 si cortaría el webhook real (nunca llegó una request con
 * clave, o llegó una sin clave hace menos de 1 h), salvo `force: true` (el panel lo pide
 * con confirmación explícita y el motivo).
 * `apply` registra el destino vigente en Kommo (lib/kommo-webhook-apply.ts) y, si salió bien,
 * confirma en la base que Kommo usa el secreto vigente.
 * `rotate` es atómica en la base (kommo_webhook_rotate): el vigente pasa a anterior (24 h)
 * y se rechaza con 409 si el anterior sigue vigente y Kommo no confirmó el actual (rotar
 * otra vez perdería el único secreto que Kommo tiene). Después aplica a Kommo; si Kommo
 * falla, la respuesta trae `kommoError` (la clave ya rotó; el panel lo muestra como error
 * y ofrece «Actualizar en Kommo»).
 */
const PREVIOUS_GRACE_HOURS = 24;

function baseUrl(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || null;
}

async function readState() {
  const svc = createServiceClient();
  const [{ data: sec, error: e1 }, { data: auth, error: e2 }] = await Promise.all([
    svc.from("_app_secrets").select("valor").eq("clave", "KOMMO_WEBHOOK_SECRET").maybeSingle(),
    svc.from("kommo_webhook_auth").select("*").eq("singleton", true).maybeSingle(),
  ]);
  if (e1 || e2) throw new Error((e1 ?? e2)!.message);
  return { secret: (sec?.valor as string | undefined) ?? null, auth };
}

/** Aplica a Kommo el destino con `secret` y, si salió bien, confirma el vigente en la base. */
async function applySecret(base: string, secret: string) {
  const cfg = await configValues(["KOMMO_API_DOMAIN", "KOMMO_ACCESS_TOKEN"]);
  const r = await applyWebhookDestination(
    { dominio: cfg.KOMMO_API_DOMAIN, token: cfg.KOMMO_ACCESS_TOKEN },
    webhookDestination(base, secret),
  );
  if (r.ok) {
    const { error } = await createServiceClient().rpc("kommo_webhook_mark_applied", { p_secret: secret });
    if (error) console.warn("webhook-auth: no se pudo registrar la confirmación:", error.message);
  }
  return r;
}

export async function GET() {
  const gate = await requireScope("configuracion");
  if (!gate.ok) return gate.response;
  const base = baseUrl();
  if (!base) return NextResponse.json({ url: null });
  try {
    const { secret, auth } = await readState();
    const prevExp = auth?.previous_expires_at ? Date.parse(auth.previous_expires_at) : NaN;
    const confirmed =
      Boolean(auth?.current_confirmed_at) &&
      (!auth?.rotated_at || Date.parse(auth.current_confirmed_at) >= Date.parse(auth.rotated_at));
    return NextResponse.json({
      url: webhookDestination(base, secret),
      mode: auth?.mode ?? "permissive",
      strictAfterHours: auth?.strict_after_hours ?? 24,
      strictSince: auth?.strict_since ?? null,
      strictReason: auth?.strict_reason ?? null,
      lastSignedAt: auth?.last_signed_at ?? null,
      lastUnsignedAt: auth?.last_unsigned_at ?? null,
      lastRejectedAt: auth?.last_rejected_at ?? null,
      lastRejectedReason: auth?.last_rejected_reason ?? null,
      rotatedAt: auth?.rotated_at ?? null,
      currentConfirmedAt: auth?.current_confirmed_at ?? null,
      rotationPending: Number.isFinite(prevExp) && prevExp > Date.now() && !confirmed,
      strictBlocker: strictModeBlocker(auth),
      secretConfigured: Boolean(secret),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const gate = await requireScope("configuracion");
  if (!gate.ok) return gate.response;
  const base = baseUrl();
  if (!base) return NextResponse.json({ error: "Falta NEXT_PUBLIC_SUPABASE_URL" }, { status: 500 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; mode?: string; force?: boolean };
  const svc = createServiceClient();

  try {
    if (body.action === "set_mode") {
      if (body.mode !== "strict" && body.mode !== "permissive") {
        return NextResponse.json({ error: "mode inválido" }, { status: 400 });
      }
      const strict = body.mode === "strict";
      if (strict && body.force !== true) {
        const { auth } = await readState();
        const blocker = strictModeBlocker(auth);
        if (blocker) return NextResponse.json({ error: blocker.message, blocker, needsForce: true }, { status: 409 });
      }
      const { error } = await svc
        .from("kommo_webhook_auth")
        .update({
          mode: body.mode,
          strict_since: strict ? new Date().toISOString() : null,
          strict_reason: strict ? (body.force === true ? "manual_forced" : "manual") : null,
          updated_at: new Date().toISOString(),
        })
        .eq("singleton", true);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, mode: body.mode });
    }

    if (body.action === "apply") {
      const { secret } = await readState();
      if (!secret) return NextResponse.json({ error: "No hay secreto configurado (migración 0073 sin aplicar)" }, { status: 409 });
      const r = await applySecret(base, secret);
      return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: 502 });
    }

    if (body.action === "rotate") {
      const next = generateWebhookSecret();
      // Primero la base (atómica; el nuevo y el anterior valen a la vez), después Kommo: sin downtime.
      const { data: outcome, error } = await svc.rpc("kommo_webhook_rotate", {
        p_new: next,
        p_grace_hours: PREVIOUS_GRACE_HOURS,
      });
      if (error) throw new Error(error.message);
      if (outcome === "pending_confirmation") {
        return NextResponse.json(
          {
            error:
              "Hay una rotación sin confirmar: Kommo todavía no usó la clave vigente y la anterior sigue valiendo. " +
              "Rotar otra vez dejaría a Kommo sin ninguna clave válida. Pulsá «Actualizar en Kommo» (o esperá a que " +
              "llegue una request con la clave vigente) y volvé a intentar.",
            code: "rotation_pending",
          },
          { status: 409 },
        );
      }
      const r = await applySecret(base, next);
      return NextResponse.json({
        ok: true,
        kommoUpdated: r.ok,
        kommoError: r.ok ? null : r.error,
        url: webhookDestination(base, next),
      });
    }

    return NextResponse.json({ error: "acción inválida" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: maskDestination(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
