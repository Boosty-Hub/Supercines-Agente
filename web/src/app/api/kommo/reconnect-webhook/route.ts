import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValues } from "@/lib/runtime-config";
import { createServiceClient } from "@/lib/supabase/service";
import { SETTINGS_DEFAULT, WEBHOOK_PATH, webhookDestination } from "@/lib/kommo-webhook";
import { truncateGraphemes } from "@/lib/text-safe";

/**
 * Re-suscribe el webhook de Kommo cuando Kommo lo deshabilitó.
 *
 * Kommo apaga la suscripción (`disabled: true`) tras varias entregas
 * fallidas seguidas. El efecto es un apagón TOTAL: no entra ni un lead ni un
 * mensaje, y Kommo no reenvía nada de lo perdido. Reactivar es un
 * `POST /api/v4/webhooks` con el mismo destination — la API es idempotente:
 * re-postear una suscripción existente la vuelve a habilitar en vez de
 * duplicarla.
 *
 * Alcance `configuracion` — lo hace cumplir el middleware sobre el prefijo
 * `/api/kommo` (ya existente en `PATH_SCOPES`): toca la integración con el CRM.
 */

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cfg = await configValues(["KOMMO_API_DOMAIN", "KOMMO_ACCESS_TOKEN"]);
  const dominio = cfg.KOMMO_API_DOMAIN;
  const token = cfg.KOMMO_ACCESS_TOKEN;
  if (!dominio || !token) {
    return NextResponse.json({ error: "Falta configurar la conexión con Kommo" }, { status: 400 });
  }

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) {
    return NextResponse.json({ error: "Falta NEXT_PUBLIC_SUPABASE_URL" }, { status: 500 });
  }
  // El destino lleva el secreto (?token=): sin él, en modo estricto la función rechaza todo.
  const { data: sec } = await createServiceClient()
    .from("_app_secrets")
    .select("valor")
    .eq("clave", "KOMMO_WEBHOOK_SECRET")
    .maybeSingle();
  const destination = webhookDestination(base, (sec?.valor as string | undefined) ?? null);

  try {
    // Conservar los settings que ya tenía: si el operador sumó eventos a
    // mano, re-suscribir con los defaults se los borraría en silencio.
    let settings = SETTINGS_DEFAULT;
    const previo = await fetch(`https://${dominio}/api/v4/webhooks`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (previo.ok) {
      const j = await previo.json();
      const mio = (j?._embedded?.webhooks ?? []).find(
        (w: { destination?: string }) => (w?.destination ?? "").includes(WEBHOOK_PATH),
      );
      if (Array.isArray(mio?.settings) && mio.settings.length > 0) settings = mio.settings;
    }

    const res = await fetch(`https://${dominio}/api/v4/webhooks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ destination, settings }),
    });
    if (!res.ok) {
      const detalle = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Kommo respondió ${res.status}: ${truncateGraphemes(detalle, 300)}` },
        { status: 502 },
      );
    }

    // Verificar que quedó habilitado de verdad antes de cerrar el incidente.
    // Cerrarlo por haber recibido un 200 sería confiar en el efecto sin mirar
    // el resultado — y dejaría la franja apagada con la ingesta todavía muerta.
    const verif = await fetch(`https://${dominio}/api/v4/webhooks`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const vj = verif.ok ? await verif.json() : null;
    const activo = (vj?._embedded?.webhooks ?? []).some(
      (w: { destination?: string; disabled?: boolean }) =>
        w?.destination === destination && w?.disabled !== true,
    );

    if (!activo) {
      return NextResponse.json(
        {
          error:
            "Kommo aceptó el pedido pero el webhook sigue deshabilitado. Revisalo en Kommo → Ajustes → Integraciones.",
        },
        { status: 502 },
      );
    }

    await supabase
      .from("system_incidents")
      .update({ resolved_at: new Date().toISOString() })
      .eq("kind", "kommo_webhook_caido")
      .is("resolved_at", null);

    return NextResponse.json({ ok: true, destination, settings });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
