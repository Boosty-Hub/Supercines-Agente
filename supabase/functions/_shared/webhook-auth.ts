// _shared/webhook-auth.ts
// Autenticidad del webhook de Kommo (la única Edge Function pública). Kommo no firma
// sus requests: el único control posible es un secreto en la URL (?token=...).
//
// El secreto vive en `_app_secrets` (KOMMO_WEBHOOK_SECRET; el anterior, aceptado hasta
// previous_expires_at para rotar sin downtime) y el modo en `kommo_webhook_auth`:
//   - 'permissive' (transición para clientes vivos, que hoy tienen la URL sin secreto en
//     Kommo): se acepta también lo que no trae secreto, y se registra para alertar.
//   - 'strict': lo que no trae un secreto válido se rechaza con 401 genérico.
// Un secreto presente pero INCORRECTO se rechaza siempre: nunca es Kommo bien configurado.
//
// FAIL-OPEN si el estado no se puede leer (DB caída, migración sin aplicar): rechazar
// haría que Kommo DESHABILITE el webhook y el sistema quedara mudo días (ver CLAUDE.md,
// invariante 6). El costo es una ventana corta sin la protección, nunca un apagón.
//
// KOMMO_WEBHOOK_SECRET (env, legado) y el query param `secret` se siguen aceptando como
// un secreto válido más, para que un cliente que ya lo usaba no quede afuera al desplegar.

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { timingSafeEqual } from "./auth.ts";

export const WEBHOOK_SECRET_KEY = "KOMMO_WEBHOOK_SECRET";
export const WEBHOOK_SECRET_PREVIOUS_KEY = "KOMMO_WEBHOOK_SECRET_PREVIOUS";

export type WebhookMode = "permissive" | "strict";

export type WebhookAuthState = {
  mode: WebhookMode;
  /** Secretos aceptados (vigente, anterior si no venció, y el legado de env). */
  secrets: string[];
};

export type WebhookDecision = {
  allow: boolean;
  /** true solo si trajo un secreto válido. */
  signed: boolean;
  reason: "ok" | "state_unavailable" | "no_secret_configured" | "unsigned_permissive" | "unsigned_strict" | "bad_token";
};

/** El token puede venir como ?token= (canónico), ?secret= (legado) o el header x-webhook-secret. */
export function extractToken(url: URL, headers: Headers): string | null {
  return (
    url.searchParams.get("token") ?? url.searchParams.get("secret") ?? headers.get("x-webhook-secret") ?? null
  ) || null;
}

/** Comparación en tiempo constante contra TODOS los secretos (sin cortar en el primero). */
export function matchesAnySecret(provided: string, secrets: readonly string[]): boolean {
  let ok = false;
  for (const s of secrets) if (timingSafeEqual(provided, s)) ok = true;
  return ok;
}

export function decideWebhook(provided: string | null, state: WebhookAuthState | null): WebhookDecision {
  if (!state) return { allow: true, signed: false, reason: "state_unavailable" };
  if (state.secrets.length === 0) return { allow: true, signed: false, reason: "no_secret_configured" };
  if (provided) {
    return matchesAnySecret(provided, state.secrets)
      ? { allow: true, signed: true, reason: "ok" }
      : { allow: false, signed: false, reason: "bad_token" };
  }
  return state.mode === "strict"
    ? { allow: false, signed: false, reason: "unsigned_strict" }
    : { allow: true, signed: false, reason: "unsigned_permissive" };
}

export const FORBIDDEN = (): Response =>
  new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

// ---- Estado (caché de 30 s por instancia: el webhook no paga una query por request) ----
const TTL_MS = 30_000;
let cache: { state: WebhookAuthState; loadedAt: number } | null = null;

/** Solo para tests. */
export function resetWebhookAuthCache(): void {
  cache = null;
}

export async function loadWebhookAuthState(
  supabase: SupabaseClient,
  legacyEnvSecret = "",
  nowMs = Date.now(),
): Promise<WebhookAuthState | null> {
  if (cache && nowMs - cache.loadedAt < TTL_MS) return cache.state;
  try {
    const [secrets, auth] = await Promise.all([
      (supabase as any).from("_app_secrets").select("clave, valor").in("clave", [WEBHOOK_SECRET_KEY, WEBHOOK_SECRET_PREVIOUS_KEY]),
      (supabase as any).from("kommo_webhook_auth").select("mode, previous_expires_at").eq("singleton", true).maybeSingle(),
    ]);
    if (secrets.error || auth.error || !auth.data) throw new Error(secrets.error?.message ?? auth.error?.message ?? "sin estado");
    const byKey = new Map<string, string>((secrets.data ?? []).map((r: any) => [r.clave, r.valor]));
    const list: string[] = [];
    const current = byKey.get(WEBHOOK_SECRET_KEY);
    if (current) list.push(current);
    const prev = byKey.get(WEBHOOK_SECRET_PREVIOUS_KEY);
    const prevOk = prev && auth.data.previous_expires_at && Date.parse(auth.data.previous_expires_at) > nowMs;
    if (prev && prevOk) list.push(prev);
    if (legacyEnvSecret) list.push(legacyEnvSecret);
    const state: WebhookAuthState = { mode: auth.data.mode === "strict" ? "strict" : "permissive", secrets: list };
    cache = { state, loadedAt: nowMs };
    return state;
  } catch (e) {
    console.warn("webhook-auth: no se pudo leer el estado, se acepta (fail-open):", e instanceof Error ? e.message : e);
    return cache?.state ?? null; // el último estado conocido, si lo hay
  }
}

// ---- Registro de requests (alerta y paso automático a strict), estrangulado ----
const NOTE_EVERY_MS = 60_000;
const lastNote: Record<"signed" | "unsigned", number> = { signed: 0, unsigned: 0 };

/** Solo para tests. */
export function resetWebhookNoteThrottle(): void {
  lastNote.signed = 0;
  lastNote.unsigned = 0;
}

/**
 * Avisa a la base (kommo_webhook_note) de una request aceptada. Como mucho una por
 * minuto y tipo por instancia; fail-soft. Si la base promueve a strict, se descarta el
 * caché para que el modo nuevo rija enseguida en esta instancia.
 */
export async function noteWebhookRequest(supabase: SupabaseClient, signed: boolean, nowMs = Date.now()): Promise<void> {
  const k = signed ? "signed" : "unsigned";
  if (nowMs - lastNote[k] < NOTE_EVERY_MS) return;
  lastNote[k] = nowMs;
  try {
    const { data, error } = await (supabase as any).rpc("kommo_webhook_note", { p_signed: signed });
    if (error) throw new Error(error.message);
    if (data === "strict") cache = null;
  } catch (e) {
    console.warn("webhook-auth: kommo_webhook_note falló:", e instanceof Error ? e.message : e);
  }
}
