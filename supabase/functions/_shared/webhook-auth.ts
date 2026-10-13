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
// FAIL-OPEN si el estado no se puede leer (DB caída o lenta, migración sin aplicar):
// rechazar haría que Kommo DESHABILITE el webhook y el sistema quedara mudo días (ver
// CLAUDE.md, invariante 6). El costo es una ventana corta sin la protección, nunca un apagón.
//
// LATENCIA (invariante 6): leer el estado NUNCA puede colgar la respuesta al webhook.
//   - Tope de espera AUTH_WAIT_MS por request; vencido → último estado conocido o fail-open.
//   - Una sola consulta en vuelo por instancia (ráfagas concurrentes la comparten), con un
//     techo duro propio (FETCH_TIMEOUT_MS) para que una conexión colgada no la retenga.
//   - Stale-while-revalidate: con el caché vencido se responde con él y se refresca en
//     segundo plano (EdgeRuntime.waitUntil).
//   - Caché NEGATIVO (NEGATIVE_TTL_MS): tras un fallo no se vuelve a consultar en cada
//     request (p. ej. 0070 sin aplicar → una consulta cada pocos segundos, no por request).
//
// ROTACIÓN: tras rotar, una instancia caliente puede tener el secreto viejo en caché. Ante
// `bad_token` con un caché de más de BAD_TOKEN_RECHECK_MS se recarga UNA vez (mismo tope,
// misma promesa compartida) antes de rechazar, para no tirar los mensajes con el token nuevo.
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
  /** El secreto vigente (para saber si Kommo ya usa el último; confirma una rotación). */
  current?: string | null;
};

export type WebhookDecision = {
  allow: boolean;
  /** true solo si trajo un secreto válido. */
  signed: boolean;
  /** true solo si el secreto que trajo es el VIGENTE (no el anterior ni el legado). */
  current?: boolean;
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
    if (!matchesAnySecret(provided, state.secrets)) return { allow: false, signed: false, reason: "bad_token" };
    const current = Boolean(state.current) && timingSafeEqual(provided, state.current as string);
    return { allow: true, signed: true, current, reason: "ok" };
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

// ---- Estado: caché por instancia con tope de espera, dedupe, SWR y caché negativo ----

/** Frescura del caché: dentro de esta ventana no se consulta la base. */
export const TTL_MS = 30_000;
/** Lo máximo que una request espera el estado antes de seguir (último conocido o fail-open). */
export const AUTH_WAIT_MS = 700;
/** Techo duro de la consulta en vuelo (libera la promesa compartida si la conexión se cuelga). */
export const FETCH_TIMEOUT_MS = 5_000;
/** Tras un fallo (o un timeout) no se vuelve a consultar durante esta ventana. */
export const NEGATIVE_TTL_MS = 5_000;
/** Ante bad_token, se recarga sin caché solo si el caché tiene más de esto. */
export const BAD_TOKEN_RECHECK_MS = 1_500;

/** Lo que se lee de la base; los secretos aceptados se derivan al decidir (el anterior vence). */
type RawState = {
  mode: WebhookMode;
  current: string | null;
  previous: string | null;
  previousExpiresAt: number | null;
};

let cache: { raw: RawState; loadedAt: number } | null = null;
let failedAt: number | null = null;
let inflight: Promise<RawState | null> | null = null;

/** Solo para tests. */
export function resetWebhookAuthCache(): void {
  cache = null;
  failedAt = null;
  inflight = null;
}

export type LoadOptions = {
  /** Reloj (tests). */
  now?: () => number;
  /** Registra trabajo en segundo plano (default: EdgeRuntime.waitUntil si existe). */
  background?: (p: Promise<unknown>) => void;
  waitMs?: number;
  fetchTimeoutMs?: number;
};

function defaultBackground(p: Promise<unknown>): void {
  // @ts-ignore: EdgeRuntime existe en Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(p);
}

/** Rechaza si `p` no resuelve en `ms`; limpia el timer en cualquier desenlace. */
function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function fetchRaw(supabase: SupabaseClient): Promise<RawState> {
  const [secrets, auth] = await Promise.all([
    (supabase as any).from("_app_secrets").select("clave, valor").in("clave", [WEBHOOK_SECRET_KEY, WEBHOOK_SECRET_PREVIOUS_KEY]),
    (supabase as any).from("kommo_webhook_auth").select("mode, previous_expires_at").eq("singleton", true).maybeSingle(),
  ]);
  if (secrets.error || auth.error || !auth.data) throw new Error(secrets.error?.message ?? auth.error?.message ?? "sin estado");
  const byKey = new Map<string, string>((secrets.data ?? []).map((r: any) => [r.clave, r.valor]));
  const exp = auth.data.previous_expires_at ? Date.parse(auth.data.previous_expires_at) : NaN;
  return {
    mode: auth.data.mode === "strict" ? "strict" : "permissive",
    current: byKey.get(WEBHOOK_SECRET_KEY) || null,
    previous: byKey.get(WEBHOOK_SECRET_PREVIOUS_KEY) || null,
    previousExpiresAt: Number.isFinite(exp) ? exp : null,
  };
}

function derive(raw: RawState, legacyEnvSecret: string, nowMs: number): WebhookAuthState {
  const secrets: string[] = [];
  if (raw.current) secrets.push(raw.current);
  if (raw.previous && raw.previousExpiresAt !== null && raw.previousExpiresAt > nowMs) secrets.push(raw.previous);
  if (legacyEnvSecret) secrets.push(legacyEnvSecret);
  return { mode: raw.mode, secrets, current: raw.current };
}

/**
 * La ÚNICA consulta en vuelo de la instancia (todas las requests la comparten). Nunca
 * rechaza: ante error o techo duro marca el caché negativo y resuelve null.
 */
function refresh(supabase: SupabaseClient, now: () => number, fetchTimeoutMs: number): Promise<RawState | null> {
  if (inflight) return inflight;
  const p = withTimeout(fetchRaw(supabase), fetchTimeoutMs)
    .then((raw) => {
      cache = { raw, loadedAt: now() };
      failedAt = null;
      return raw;
    })
    .catch((e) => {
      failedAt = now();
      console.warn("webhook-auth: no se pudo leer el estado (se usa el último conocido o fail-open):", e instanceof Error ? e.message : e);
      return null;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

const negativeActive = (nowMs: number) => failedAt !== null && nowMs - failedAt < NEGATIVE_TTL_MS;

/** Espera la consulta compartida como mucho `waitMs`; vencido el tope, la deja seguir en segundo plano. */
async function awaitRefresh(supabase: SupabaseClient, opts: Required<LoadOptions>): Promise<RawState | null> {
  const p = refresh(supabase, opts.now, opts.fetchTimeoutMs);
  opts.background(p);
  try {
    return await withTimeout(p, opts.waitMs);
  } catch {
    // Tope de espera vencido: la base está lenta o colgada. Caché negativo para que las
    // siguientes requests no esperen otra vez (la consulta sigue y, si llega, puebla el caché).
    failedAt = opts.now();
    return null;
  }
}

function resolveOpts(o: LoadOptions = {}): Required<LoadOptions> {
  return {
    now: o.now ?? Date.now,
    background: o.background ?? defaultBackground,
    waitMs: o.waitMs ?? AUTH_WAIT_MS,
    fetchTimeoutMs: o.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
  };
}

/**
 * Estado vigente para decidir. Nunca espera más de `waitMs` y nunca lanza:
 *  - caché fresco → al instante;
 *  - caché vencido → al instante con el vencido, y refresca en segundo plano;
 *  - sin caché → espera la consulta compartida hasta el tope; si no llega, null (fail-open);
 *  - caché negativo activo → no consulta: último conocido o null.
 */
export async function loadWebhookAuthState(
  supabase: SupabaseClient,
  legacyEnvSecret = "",
  options: LoadOptions = {},
): Promise<WebhookAuthState | null> {
  const opts = resolveOpts(options);
  const nowMs = opts.now();
  if (cache && nowMs - cache.loadedAt < TTL_MS) return derive(cache.raw, legacyEnvSecret, nowMs);
  if (cache) {
    if (!negativeActive(nowMs)) {
      const p = refresh(supabase, opts.now, opts.fetchTimeoutMs);
      opts.background(p);
    }
    return derive(cache.raw, legacyEnvSecret, nowMs);
  }
  if (negativeActive(nowMs)) return null;
  const raw = await awaitRefresh(supabase, opts);
  return raw ? derive(raw, legacyEnvSecret, opts.now()) : null;
}

/**
 * Decide la request completa: carga el estado (con los topes de arriba) y, si el token no
 * coincide con un caché de más de BAD_TOKEN_RECHECK_MS, recarga UNA vez (consulta
 * compartida, mismo tope) antes de rechazar: puede ser el token nuevo de una rotación que
 * esta instancia todavía no vio. Si la recarga no llega a tiempo se rechaza igual (un token
 * presente e incorrecto nunca se acepta a ciegas).
 */
export async function authorizeWebhook(
  supabase: SupabaseClient,
  token: string | null,
  legacyEnvSecret = "",
  options: LoadOptions = {},
): Promise<WebhookDecision> {
  const opts = resolveOpts(options);
  const decision = decideWebhook(token, await loadWebhookAuthState(supabase, legacyEnvSecret, opts));
  if (decision.reason !== "bad_token" || !cache) return decision;
  const nowMs = opts.now();
  if (nowMs - cache.loadedAt <= BAD_TOKEN_RECHECK_MS || negativeActive(nowMs)) return decision;
  const raw = await awaitRefresh(supabase, opts);
  if (!raw) return decision;
  return decideWebhook(token, derive(raw, legacyEnvSecret, opts.now()));
}

// ---- Registro de requests (alerta, confirmación de rotación y paso automático a strict) ----
const NOTE_EVERY_MS = 60_000;
type NoteKind = "current" | "signed" | "unsigned";
const lastNote: Record<NoteKind, number> = { current: 0, signed: 0, unsigned: 0 };

/** Solo para tests. */
export function resetWebhookNoteThrottle(): void {
  lastNote.current = 0;
  lastNote.signed = 0;
  lastNote.unsigned = 0;
}

/**
 * Avisa a la base (kommo_webhook_note) de una request aceptada. Como mucho una por
 * minuto y tipo (firmada con el vigente / firmada con otro / sin firma) por instancia;
 * fail-soft. Firmada con el VIGENTE confirma la última rotación (Kommo ya lo usa). Si la
 * base promueve a strict, se vence el caché para que el modo nuevo rija enseguida.
 */
export async function noteWebhookRequest(
  supabase: SupabaseClient,
  signed: boolean,
  nowMs = Date.now(),
  current = false,
): Promise<void> {
  const k: NoteKind = !signed ? "unsigned" : current ? "current" : "signed";
  if (nowMs - lastNote[k] < NOTE_EVERY_MS) return;
  lastNote[k] = nowMs;
  try {
    const { data, error } = await (supabase as any).rpc("kommo_webhook_note", {
      p_signed: signed,
      p_current: signed && current,
    });
    if (error) throw new Error(error.message);
    // Vencerlo (no borrarlo): la próxima request sirve el estado conocido y refresca en
    // segundo plano, sin esperar a la base.
    if (data === "strict" && cache) cache = { ...cache, loadedAt: -Infinity };
  } catch (e) {
    console.warn("webhook-auth: kommo_webhook_note falló:", e instanceof Error ? e.message : e);
  }
}
