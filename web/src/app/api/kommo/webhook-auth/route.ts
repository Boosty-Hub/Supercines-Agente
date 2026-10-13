import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { configValues } from "@/lib/runtime-config";
import {
  generateWebhookSecret,
  maskDestination,
  planWebhookUpdate,
  webhookDestination,
  type KommoHook,
} from "@/lib/kommo-webhook";

/**
 * Autenticidad del webhook de Kommo (secreto en la URL). Alcance `configuracion`
 * (middleware, prefijo /api/kommo).
 *
 *  GET   → URL completa con el secreto + estado del modo (para Configuración → Kommo y /setup).
 *  POST  → { action: "set_mode", mode } · { action: "apply" } · { action: "rotate" }
 *
 * `apply` actualiza la suscripción en Kommo por API (POST del destino nuevo y DELETE del
 * viejo: Kommo no edita la URL). `rotate` genera otro secreto, deja el anterior válido 24 h
 * (así no hay downtime mientras Kommo cambia de URL) y aplica a Kommo si está conectado.
 */
const PREVIOUS_GRACE_MS = 24 * 3600 * 1000;

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

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

/** Deja a Kommo apuntando SOLO al destino con el secreto vigente. */
async function applyToKommo(destination: string): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
  const cfg = await configValues(["KOMMO_API_DOMAIN", "KOMMO_ACCESS_TOKEN"]);
  const dominio = cfg.KOMMO_API_DOMAIN;
  const token = cfg.KOMMO_ACCESS_TOKEN;
  if (!dominio || !token) return { ok: false, error: "Falta configurar la conexión con Kommo" };
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const list = async (): Promise<KommoHook[]> => {
    const r = await fetch(`https://${dominio}/api/v4/webhooks`, { headers: H, cache: "no-store" });
    if (!r.ok) throw new Error(`Kommo respondió ${r.status} al listar los webhooks`);
    return ((await r.json())?._embedded?.webhooks ?? []) as KommoHook[];
  };
  try {
    const plan = planWebhookUpdate(await list(), destination);
    // 1) registrar el nuevo (idempotente por destino)  2) recién entonces dar de baja el viejo.
    const post = await fetch(`https://${dominio}/api/v4/webhooks`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ destination, settings: plan.settings }),
    });
    if (!post.ok) {
      return { ok: false, error: `Kommo respondió ${post.status}: ${(await post.text().catch(() => "")).slice(0, 200)}` };
    }
    const verif = await list();
    if (!verif.some((h) => h.destination === destination && h.disabled !== true)) {
      return { ok: false, error: "Kommo aceptó el pedido pero el webhook nuevo no quedó habilitado. Revisalo en Kommo → Integraciones." };
    }
    let removed = 0;
    for (const old of plan.toDelete) {
      const del = await fetch(`https://${dominio}/api/v4/webhooks`, {
        method: "DELETE",
        headers: H,
        body: JSON.stringify({ destination: old }),
      });
      if (del.ok) removed++;
      else console.warn(`webhook-auth: no se pudo dar de baja ${maskDestination(old)} (${del.status})`);
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  if (!(await requireUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const base = baseUrl();
  if (!base) return NextResponse.json({ url: null });
  try {
    const { secret, auth } = await readState();
    return NextResponse.json({
      url: webhookDestination(base, secret),
      mode: auth?.mode ?? "permissive",
      strictAfterHours: auth?.strict_after_hours ?? 24,
      strictSince: auth?.strict_since ?? null,
      strictReason: auth?.strict_reason ?? null,
      lastSignedAt: auth?.last_signed_at ?? null,
      lastUnsignedAt: auth?.last_unsigned_at ?? null,
      secretConfigured: Boolean(secret),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await requireUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const base = baseUrl();
  if (!base) return NextResponse.json({ error: "Falta NEXT_PUBLIC_SUPABASE_URL" }, { status: 500 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; mode?: string };
  const svc = createServiceClient();

  try {
    if (body.action === "set_mode") {
      if (body.mode !== "strict" && body.mode !== "permissive") {
        return NextResponse.json({ error: "mode inválido" }, { status: 400 });
      }
      const strict = body.mode === "strict";
      const { error } = await svc
        .from("kommo_webhook_auth")
        .update({
          mode: body.mode,
          strict_since: strict ? new Date().toISOString() : null,
          strict_reason: strict ? "manual" : null,
          updated_at: new Date().toISOString(),
        })
        .eq("singleton", true);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, mode: body.mode });
    }

    if (body.action === "apply") {
      const { secret } = await readState();
      if (!secret) return NextResponse.json({ error: "No hay secreto configurado (migración 0073 sin aplicar)" }, { status: 409 });
      const r = await applyToKommo(webhookDestination(base, secret));
      return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: 502 });
    }

    if (body.action === "rotate") {
      const { secret: current } = await readState();
      const next = generateWebhookSecret();
      // Primero la base (el nuevo y el anterior valen a la vez), después Kommo: sin downtime.
      const ops = [
        svc.from("_app_secrets").upsert({ clave: "KOMMO_WEBHOOK_SECRET", valor: next }, { onConflict: "clave" }),
        svc
          .from("kommo_webhook_auth")
          .update({ previous_expires_at: new Date(Date.now() + PREVIOUS_GRACE_MS).toISOString(), updated_at: new Date().toISOString() })
          .eq("singleton", true),
      ];
      if (current) {
        ops.unshift(svc.from("_app_secrets").upsert({ clave: "KOMMO_WEBHOOK_SECRET_PREVIOUS", valor: current }, { onConflict: "clave" }));
      }
      for (const op of ops) {
        const { error } = await op;
        if (error) throw new Error(error.message);
      }
      const r = await applyToKommo(webhookDestination(base, next));
      return NextResponse.json({
        ok: true,
        kommoUpdated: r.ok,
        kommoError: r.ok ? null : r.error,
        url: webhookDestination(base, next),
      });
    }

    return NextResponse.json({ error: "acción inválida" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
