import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { configValues } from "@/lib/runtime-config";
import { createServiceClient } from "@/lib/supabase/service";
import { maskDestination, webhookDestination } from "@/lib/kommo-webhook";
import { applyWebhookDestination } from "@/lib/kommo-webhook-apply";

/**
 * Re-suscribe el webhook de Kommo cuando Kommo lo deshabilitó.
 *
 * Kommo apaga la suscripción (`disabled: true`) tras varias entregas
 * fallidas seguidas. El efecto es un apagón TOTAL: no entra ni un lead ni un
 * mensaje, y Kommo no reenvía nada de lo perdido. Reactivar es un
 * `POST /api/v4/webhooks` con el destino vigente (con el secreto): re-postear
 * una suscripción existente la vuelve a habilitar en vez de duplicarla. Usa el
 * MISMO camino que «Actualizar en Kommo» (`applyWebhookDestination`): POST del
 * destino vigente, verificación y DELETE de los destinos viejos nuestros (p. ej.
 * el que quedó sin secreto), conservando los eventos que el operador sumó a mano.
 *
 * Alcance `configuracion` — lo hace cumplir el middleware sobre el prefijo
 * `/api/kommo` (ya existente en `PATH_SCOPES`): toca la integración con el CRM.
 */

export async function POST() {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) {
    return NextResponse.json({ error: "Falta NEXT_PUBLIC_SUPABASE_URL" }, { status: 500 });
  }
  try {
    // El destino lleva el secreto (?token=): sin él, en modo estricto la función rechaza todo.
    const service = createServiceClient();
    const { data: sec, error: secErr } = await service
      .from("_app_secrets")
      .select("valor")
      .eq("clave", "KOMMO_WEBHOOK_SECRET")
      .maybeSingle();
    if (secErr) throw new Error(secErr.message);
    const destination = webhookDestination(base, (sec?.valor as string | undefined) ?? null);

    const cfg = await configValues(["KOMMO_API_DOMAIN", "KOMMO_ACCESS_TOKEN"]);
    const r = await applyWebhookDestination({ dominio: cfg.KOMMO_API_DOMAIN, token: cfg.KOMMO_ACCESS_TOKEN }, destination);
    if (!r.ok) {
      const sinConexion = !cfg.KOMMO_API_DOMAIN || !cfg.KOMMO_ACCESS_TOKEN;
      return NextResponse.json({ error: r.error }, { status: sinConexion ? 400 : 502 });
    }

    // Recién con el webhook verificado como habilitado se cierra el incidente. Con el cliente
    // de SERVICIO: la RLS de system_incidents no deja a la sesión escribir `resolved_at` (solo
    // silenciar), así que con la sesión el update no cerraba nada y nadie se enteraba. Si falla,
    // se dice: el webhook quedó reconectado y health-scan lo cierra en su próximo barrido.
    const { error: incErr } = await service
      .from("system_incidents")
      .update({ resolved_at: new Date().toISOString() })
      .eq("kind", "kommo_webhook_caido")
      .is("resolved_at", null);
    if (incErr) {
      return NextResponse.json(
        {
          error: `Webhook reconectado, pero no se pudo cerrar el incidente: ${incErr.message}. Se cierra solo en el próximo barrido de salud.`,
          reconnected: true,
          destination: maskDestination(destination),
        },
        { status: 500 }
      );
    }

    // La respuesta NO devuelve el secreto: la URL completa solo la muestra el panel.
    return NextResponse.json({ ok: true, destination: maskDestination(destination), settings: r.settings, removed: r.removed });
  } catch (e) {
    return NextResponse.json({ error: maskDestination(e instanceof Error ? e.message : String(e)) }, { status: 500 });
  }
}
