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
import { createServiceClient } from "@/lib/supabase/service";

export const INTERNAL_SECRET_KEY = "INTERNAL_FUNCTION_SECRET";
const INTERNAL_SECRET_HEADER = "x-internal-secret";

/** Falta el secreto: la migración que lo crea (0061) no se aplicó todavía. */
export class InternalSecretMissingError extends Error {
  constructor() {
    super("Falta el secreto interno de las funciones: aplicá las migraciones pendientes.");
    this.name = "InternalSecretMissingError";
  }
}

let cache: { value: string; loadedAt: number } | null = null;
const TTL_MS = 60_000;

async function internalSecret(): Promise<string> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache.value;
  const { data } = await createServiceClient()
    .from("_app_secrets")
    .select("valor")
    .eq("clave", INTERNAL_SECRET_KEY)
    .maybeSingle();
  if (!data?.valor) throw new InternalSecretMissingError();
  cache = { value: data.valor as string, loadedAt: Date.now() };
  return cache.value;
}

/**
 * POST a `/functions/v1/<slug>` con el secreto interno. Devuelve la Response tal
 * cual (el caller decide qué mostrar; nunca reenviar el cuerpo crudo al navegador).
 * Lanza InternalSecretMissingError si falta el secreto.
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
    headers: { "Content-Type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
}
