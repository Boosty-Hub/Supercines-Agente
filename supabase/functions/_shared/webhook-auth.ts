// _shared/webhook-auth.ts
// Autenticidad del webhook de Kommo (la única Edge Function pública). Kommo no firma
// sus requests: el único control posible es un secreto en la URL (?token=...).
//
// El secreto vive en `_app_secrets` (KOMMO_WEBHOOK_SECRET; el anterior, aceptado hasta
// previous_expires_at para rotar sin downtime) y el modo en `kommo_webhook_auth`:
//   - 'permissive' (transición para clientes vivos, que hoy tienen la URL sin secreto en
//     Kommo): se acepta también lo que no trae secreto, y se registra para alertar.
//   - 'strict': lo que no trae un secreto válido se DESCARTA (no se encola).
// Un secreto presente pero INCORRECTO se descarta siempre: nunca es Kommo bien configurado.
//
// LA DECISIÓN CORRE DESPUÉS DE RESPONDER (invariante 6). El handler
// (_shared/kommo-webhook-handler.ts) contesta 200 de inmediato y decide + persiste dentro
// de EdgeRuntime.waitUntil. Por eso aquí se puede esperar el estado REAL sin riesgo de que
// Kommo deshabilite el webhook, y por eso NO hay fail-open: sin estado conocido no se
// acepta nada (ni en estricto ni en transición); se reintenta y, si la base sigue caída,
// el payload se pierde con alerta `inbound_dropped` (con la base caída tampoco se podría
// encolar). Un rechazo es un descarte silencioso para Kommo (siempre recibe 200): el
// emisor no se entera; la auditoría queda en logs y alertas (sin el token).
//
// Carga del estado (por instancia):
//   - caché fresco TTL_MS; vencido → se usa el vencido y se refresca en segundo plano
//     (stale-while-revalidate);
//   - UNA sola consulta en vuelo (ráfagas concurrentes la comparten), con techo duro
//     FETCH_TIMEOUT_MS para que una conexión colgada no la retenga;
//   - caché NEGATIVO (NEGATIVE_TTL_MS): tras un fallo no se reconsulta en cada request;
//     las requests que esperan comparten el próximo intento;
//   - 0073 sin aplicar (tabla inexistente) NO es un fallo: es un estado conocido
//     («sin autenticación instalada» = transición sin secretos) y se cachea como tal.
//
// ROTACIÓN: una instancia caliente puede tener el secreto viejo en caché. Ante `bad_token`
// con un caché de más de BAD_TOKEN_RECHECK_MS se recarga UNA vez (consulta compartida)
// antes de descartar, para no tirar los mensajes con el token nuevo.
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
  reason:
    | "ok"
    | "state_unavailable"
    | "no_secret_configured"
    | "unsigned_permissive"
    | "unsigned_strict"
    | "bad_token";
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

/**
 * Decisión pura. Sin estado (null) NO se acepta: nunca se abre el modo estricto por no
 * poder leer la base. Sin ningún secreto configurado (0073 sin aplicar) rige el modo: en
 * transición se acepta como sin firmar; en estricto no hay nada válido y se descarta.
 */
export function decideWebhook(provided: string | null, state: WebhookAuthState | null): WebhookDecision {
  if (!state) return { allow: false, signed: false, reason: "state_unavailable" };
  if (state.secrets.length === 0) {
    return state.mode === "strict"
      ? { allow: false, signed: false, reason: "unsigned_strict" }
      : { allow: true, signed: false, reason: "no_secret_configured" };
  }
  if (provided) {
    if (!matchesAnySecret(provided, state.secrets)) return { allow: false, signed: false, reason: "bad_token" };
    const current = Boolean(state.current) && timingSafeEqual(provided, state.current as string);
    return { allow: true, signed: true, current, reason: "ok" };
  }
  return state.mode === "strict"
    ? { allow: false, signed: false, reason: "unsigned_strict" }
    : { allow: true, signed: false, reason: "unsigned_permissive" };
}

// ---- Estado: caché por instancia con dedupe, SWR y caché negativo ----

/** Frescura del caché: dentro de esta ventana no se consulta la base. */
export const TTL_MS = 30_000;
/** Techo duro de la consulta en vuelo (libera la promesa compartida si la conexión se cuelga). */
export const FETCH_TIMEOUT_MS = 5_000;
/** Tras un fallo no se vuelve a consultar durante esta ventana (las esperas comparten el siguiente intento). */
export const NEGATIVE_TTL_MS = 2_000;
/** Cuánto espera (en segundo plano) una request sin estado conocido antes de darse por perdida. */
export const STATE_DEADLINE_MS = 15_000;
/** Ante bad_token, se recarga sin caché solo si el caché tiene más de esto. */
export const BAD_TOKEN_RECHECK_MS = 1_500;

/** Lo que se lee de la base; los secretos aceptados se derivan al decidir (el anterior vence). */
type RawState = {
  mode: WebhookMode;
  current: string | null;
  previous: string | null;
  previousExpiresAt: number | null;
};

/** 0073 sin aplicar: estado CONOCIDO (transición, sin secretos), no un fallo. */
const NOT_INSTALLED: RawState = { mode: "permissive", current: null, previous: null, previousExpiresAt: null };

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
  /** Espera (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Registra trabajo en segundo plano (default: EdgeRuntime.waitUntil si existe). */
  background?: (p: Promise<unknown>) => void;
  fetchTimeoutMs?: number;
  deadlineMs?: number;
};

function defaultBackground(p: Promise<unknown>): void {
  // @ts-ignore: EdgeRuntime existe en Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(p);
}

/** Rechaza si `p` no resuelve en `ms`; limpia el timer en cualquier desenlace. */
export function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
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

/** ¿El error es «la tabla/relación no existe» (0073 sin aplicar)? */
function isMissingRelation(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /does not exist|could not find the table/i.test(err.message ?? "");
}

async function fetchRaw(supabase: SupabaseClient): Promise<RawState> {
  const [secrets, auth] = await Promise.all([
    (supabase as any).from("_app_secrets").select("clave, valor").in("clave", [WEBHOOK_SECRET_KEY, WEBHOOK_SECRET_PREVIOUS_KEY]),
    (supabase as any).from("kommo_webhook_auth").select("mode, previous_expires_at").eq("singleton", true).maybeSingle(),
  ]);
  if (isMissingRelation(auth.error)) return NOT_INSTALLED;
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

type Opts = Required<LoadOptions>;

function resolveOpts(o: LoadOptions = {}): Opts {
  return {
    now: o.now ?? Date.now,
    sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    background: o.background ?? defaultBackground,
    fetchTimeoutMs: o.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
    deadlineMs: o.deadlineMs ?? STATE_DEADLINE_MS,
  };
}

/**
 * La ÚNICA consulta en vuelo de la instancia (todas las requests la comparten). Nunca
 * rechaza: ante error o techo duro marca el caché negativo y resuelve null.
 */
function refresh(supabase: SupabaseClient, opts: Opts): Promise<RawState | null> {
  if (inflight) return inflight;
  const p = withTimeout(fetchRaw(supabase), opts.fetchTimeoutMs)
    .then((raw) => {
      cache = { raw, loadedAt: opts.now() };
      failedAt = null;
      return raw;
    })
    .catch((e) => {
      failedAt = opts.now();
      console.warn("webhook-auth: no se pudo leer el estado:", e instanceof Error ? e.message : e);
      return null;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

const negativeActive = (nowMs: number) => failedAt !== null && nowMs - failedAt < NEGATIVE_TTL_MS;

/**
 * Estado vigente, SIN reintentos. Nunca lanza:
 *  - caché fresco → al instante;
 *  - caché vencido → al instante con el vencido (último estado conocido), y refresca atrás;
 *  - sin caché → la consulta compartida (hasta su techo duro); null si falla;
 *  - caché negativo activo y sin caché → null sin consultar.
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
    if (!negativeActive(nowMs)) opts.background(refresh(supabase, opts));
    return derive(cache.raw, legacyEnvSecret, nowMs);
  }
  if (negativeActive(nowMs)) return null;
  const raw = await refresh(supabase, opts);
  return raw ? derive(raw, legacyEnvSecret, opts.now()) : null;
}

/**
 * Como loadWebhookAuthState, pero si el estado nunca se conoció reintenta (respetando el
 * caché negativo: las requests que esperan comparten cada intento) hasta `deadlineMs`.
 * Pensado para correr en segundo plano, después de responder.
 */
export async function waitForWebhookAuthState(
  supabase: SupabaseClient,
  legacyEnvSecret = "",
  options: LoadOptions = {},
): Promise<WebhookAuthState | null> {
  const opts = resolveOpts(options);
  const deadline = opts.now() + opts.deadlineMs;
  for (;;) {
    const st = await loadWebhookAuthState(supabase, legacyEnvSecret, opts);
    if (st) return st;
    const now = opts.now();
    if (now >= deadline) return null;
    const untilRetry = failedAt !== null ? Math.max(0, failedAt + NEGATIVE_TTL_MS - now) : 0;
    await opts.sleep(Math.max(1, Math.min(untilRetry, deadline - now)));
  }
}

/**
 * Decide la request completa con el estado REAL (en segundo plano): espera el estado
 * (reintentando si nunca se conoció) y, si el token no coincide con un caché de más de
 * BAD_TOKEN_RECHECK_MS, recarga UNA vez (consulta compartida) antes de descartar: puede
 * ser el token nuevo de una rotación que esta instancia todavía no vio.
 */
export async function authorizeWebhook(
  supabase: SupabaseClient,
  token: string | null,
  legacyEnvSecret = "",
  options: LoadOptions = {},
): Promise<WebhookDecision> {
  const opts = resolveOpts(options);
  const decision = decideWebhook(token, await waitForWebhookAuthState(supabase, legacyEnvSecret, opts));
  if (decision.reason !== "bad_token" || !cache) return decision;
  if (opts.now() - cache.loadedAt <= BAD_TOKEN_RECHECK_MS || negativeActive(opts.now())) return decision;
  const raw = await refresh(supabase, opts);
  if (!raw) return decision;
  return decideWebhook(token, derive(raw, legacyEnvSecret, opts.now()));
}

// ---- Registro de requests (alerta, confirmación de rotación, descartes y paso a strict) ----
const NOTE_EVERY_MS = 60_000;
export type NoteKind = "current" | "signed" | "unsigned" | "rejected";
const lastNote: Record<NoteKind, number> = { current: 0, signed: 0, unsigned: 0, rejected: 0 };

/** Solo para tests. */
export function resetWebhookNoteThrottle(): void {
  for (const k of Object.keys(lastNote) as NoteKind[]) lastNote[k] = 0;
}

/** Qué registrar de una decisión (null = nada: estado desconocido, lo cubre inbound_dropped). */
export function noteKindFor(d: WebhookDecision): NoteKind | null {
  if (d.reason === "state_unavailable") return null;
  if (!d.allow) return "rejected";
  if (!d.signed) return "unsigned";
  return d.current ? "current" : "signed";
}

/**
 * Avisa a la base (kommo_webhook_note) de una request. Como mucho una por minuto y tipo
 * por instancia; fail-soft. Firmada con el VIGENTE confirma la última rotación (Kommo ya
 * lo usa). Un descarte deja la marca y una alerta `webhook_rejected` (como mucho una cada
 * 6 h, en la base). Si la base promueve a strict, se vence el caché para que rija enseguida.
 */
export async function noteWebhookRequest(
  supabase: SupabaseClient,
  decision: WebhookDecision,
  nowMs = Date.now(),
): Promise<void> {
  const k = noteKindFor(decision);
  if (!k) return;
  if (nowMs - lastNote[k] < NOTE_EVERY_MS) return;
  lastNote[k] = nowMs;
  try {
    const { data, error } = await (supabase as any).rpc("kommo_webhook_note", {
      p_signed: decision.signed,
      p_current: decision.current === true,
      p_rejected: k === "rejected" ? decision.reason : null,
    });
    if (error) throw new Error(error.message);
    if (data === "strict" && cache) cache = { ...cache, loadedAt: -Infinity };
  } catch (e) {
    console.warn("webhook-auth: kommo_webhook_note falló:", e instanceof Error ? e.message : e);
  }
}
