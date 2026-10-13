// server-only: llamadas del servidor del panel a Edge Functions que NO son públicas.
//
// Esas funciones tienen verify_jwt = false (ni el cron ni el servidor mandan un JWT
// de usuario) pero exigen el header `x-internal-secret` (supabase/functions/_shared/
// auth.ts): un secreto interno de bajo privilegio guardado en la tabla protegida
// `_app_secrets` (migración 0061), sin policies y sin grants a anon/authenticated.
//
// Se lee AQUÍ, en el servidor, con la service key, y nunca llega al navegador. La
// ruta que use este helper es la responsable de validar sesión y alcance ANTES de
// llamarlo (getUser() + prefijo en lib/auth/roles.ts).
import "server-only";
import { runTrigger, TRIGGER_TIMEOUT_MS, type TriggerOutcome } from "@/lib/internal-trigger";
import { createServiceClient } from "@/lib/supabase/service";

export const INTERNAL_SECRET_KEY = "INTERNAL_FUNCTION_SECRET";
const INTERNAL_SECRET_HEADER = "x-internal-secret";

let cache: { value: string; loadedAt: number } | null = null;
const TTL_MS = 60_000;

async function internalSecret(): Promise<string | null> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache.value;
  const { data } = await createServiceClient()
    .from("_app_secrets")
    .select("valor")
    .eq("clave", INTERNAL_SECRET_KEY)
    .maybeSingle();
  // Sin secreto (la migración 0061 todavía no se aplicó) no se cachea el vacío.
  if (!data?.valor) return null;
  cache = { value: data.valor as string, loadedAt: Date.now() };
  return cache.value;
}

/** Mensaje para el usuario cuando una función interna contesta 401. */
export const INTERNAL_401_HINT =
  "La función rechazó la llamada interna (401). Aplicá las migraciones pendientes y redeployá las funciones desde el centro de actualizaciones.";

/**
 * POST a `/functions/v1/<slug>` con el secreto interno. Devuelve la Response tal
 * cual (el caller decide qué mostrar; nunca reenviar el cuerpo crudo al navegador).
 * Si el secreto todavía no existe (migración sin aplicar) se llama SIN header: una
 * función vieja (sin gate) igual responde y una nueva contesta 401 — el que decide
 * es la función. Así el orden de despliegue (web → migración → funciones) no corta
 * las acciones manuales del panel en ningún punto.
 */
export async function callInternalFunction(
  slug: string,
  body: unknown = {},
  opts: { timeoutMs?: number } = {}
): Promise<Response> {
  const secret = await internalSecret();
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return fetch(`${base}/functions/v1/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { [INTERNAL_SECRET_HEADER]: secret } : {}) },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
}

/**
 * Headers con el secreto interno para una URL arbitraria SOLO si apunta a una
 * Edge Function propia (`<SUPABASE_URL>/functions/v1/…`); `{}` en cualquier otro
 * caso. Lo usa el probador de tools del panel: una tool HTTP que apunta a una
 * función propia (p. ej. la cartelera) exige el secreto, y el probador debe
 * comportarse como el agente sin que el secreto viaje nunca al navegador.
 */
export async function internalHeadersForUrl(url: string): Promise<Record<string, string>> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base || !url.startsWith(`${base}/functions/v1/`)) return {};
  const secret = await internalSecret();
  return secret ? { [INTERNAL_SECRET_HEADER]: secret } : {};
}

/**
 * Dispara una función interna cuyo resultado el usuario NO necesita (publicar, generar
 * un draft): se ESPERA el acuse con timeout corto (en serverless un fetch sin await
 * puede no salir) y un fallo no se propaga, solo se registra. El barrido de pg_cron es
 * la red de seguridad. `context` identifica la acción en el log (p. ej. "draft <id>").
 */
export function triggerInternalFunction(slug: string, body: unknown, context: string): Promise<TriggerOutcome> {
  return runTrigger(() => callInternalFunction(slug, body, { timeoutMs: TRIGGER_TIMEOUT_MS }), { slug, context });
}
