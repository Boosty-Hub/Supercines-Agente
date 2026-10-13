// Aplica a Kommo el destino del webhook (con el secreto): el ÚNICO lugar que registra o
// da de baja suscripciones por API. Lo usan /api/kommo/webhook-auth (apply / rotate) y
// /api/kommo/reconnect-webhook (Kommo deshabilitó el webhook).
//
// Kommo no edita la URL de una suscripción: se registra la nueva (POST, idempotente por
// destino; re-postear una deshabilitada la rehabilita) y, verificado que quedó habilitada,
// se dan de baja las viejas nuestras (DELETE), en ese orden: nunca hay una franja sin
// webhook. El plan (qué eventos, qué borrar) es lógica pura: planWebhookUpdate.
//
// Sin imports con alias ni de servidor para poder probarse con node:test; la conexión
// (dominio + token) la leen las rutas de runtime_config.
import { maskDestination, planWebhookUpdate, type KommoHook } from "./kommo-webhook.ts";
import { truncateGraphemes } from "./text-safe.ts";

export type KommoConnection = { dominio: string | undefined | null; token: string | undefined | null };

export type ApplyResult =
  | { ok: true; removed: number; settings: string[]; failedDeletes: number }
  | { ok: false; error: string };

/** Deja a Kommo apuntando SOLO a `destination` (los webhooks ajenos no se tocan). */
export async function applyWebhookDestination(conn: KommoConnection, destination: string): Promise<ApplyResult> {
  const { dominio, token } = conn;
  if (!dominio || !token) return { ok: false, error: "Falta configurar la conexión con Kommo" };
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const url = `https://${dominio}/api/v4/webhooks`;
  // Kommo puede devolver el destino (con el secreto) en el detalle del error.
  const detail = async (r: Response) => maskDestination(truncateGraphemes(await r.text().catch(() => ""), 300));
  const list = async (): Promise<KommoHook[]> => {
    const r = await fetch(url, { headers: H, cache: "no-store" });
    if (!r.ok) throw new Error(`Kommo respondió ${r.status} al listar los webhooks`);
    return ((await r.json())?._embedded?.webhooks ?? []) as KommoHook[];
  };
  try {
    const plan = planWebhookUpdate(await list(), destination);
    // 1) registrar el nuevo (rehabilita si estaba deshabilitado)  2) verificar  3) dar de baja los viejos.
    const post = await fetch(url, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ destination, settings: plan.settings }),
    });
    if (!post.ok) return { ok: false, error: `Kommo respondió ${post.status}: ${await detail(post)}` };
    const verif = await list();
    if (!verif.some((h) => h.destination === destination && h.disabled !== true)) {
      return {
        ok: false,
        error: "Kommo aceptó el pedido pero el webhook no quedó habilitado. Revisalo en Kommo → Ajustes → Integraciones.",
      };
    }
    let removed = 0;
    let failedDeletes = 0;
    for (const old of plan.toDelete) {
      const del = await fetch(url, { method: "DELETE", headers: H, body: JSON.stringify({ destination: old }) });
      if (del.ok) removed++;
      else {
        failedDeletes++;
        console.warn(`kommo-webhook-apply: no se pudo dar de baja ${maskDestination(old)} (${del.status})`);
      }
    }
    return { ok: true, removed, settings: plan.settings, failedDeletes };
  } catch (e) {
    return { ok: false, error: maskDestination(e instanceof Error ? e.message : String(e)) };
  }
}
