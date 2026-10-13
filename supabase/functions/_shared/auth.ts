// _shared/auth.ts
// Gate de autorización para Edge Functions con verify_jwt = false que NO son un
// webhook externo (las invocan pg_cron o el servidor del panel).
//
// El secreto vive en la tabla protegida `_app_secrets` (clave
// INTERNAL_FUNCTION_SECRET, migración 0061): sin policies y con REVOKE a
// anon/authenticated, solo la leen service_role y las funciones SECURITY DEFINER
// que arman la llamada (trigger_sync_pipelines). Se manda en el header
// `x-internal-secret`. Es de bajo privilegio a propósito: si se filtra, solo
// permite invocar las funciones que lo exigen, no da acceso a la base (a
// diferencia de la service_role key, que NO se usa para esto).
//
// Uso:
//   const denied = await authorizeInternal(req, supabase);
//   if (denied) return denied;

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export const INTERNAL_SECRET_KEY = "INTERNAL_FUNCTION_SECRET";
export const INTERNAL_SECRET_HEADER = "x-internal-secret";

/** Comparación en tiempo constante (no corta en el primer byte distinto). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // Se recorre el largo del mayor para no filtrar la longitud por el tiempo.
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** ¿El header coincide con el secreto esperado? Fail-closed si falta cualquiera. */
export function isInternalSecretValid(provided: string | null, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(provided, expected);
}

let cache: { value: string | null; loadedAt: number } | null = null;
const TTL_MS = 60_000;

/** Solo para tests. */
export function resetInternalSecretCache(): void {
  cache = null;
}

async function loadSecret(supabase: SupabaseClient): Promise<string | null> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache.value;
  const { data, error } = await (supabase as any)
    .from("_app_secrets")
    .select("valor")
    .eq("clave", INTERNAL_SECRET_KEY)
    .maybeSingle();
  // Error o sin fila → null → todo se rechaza (fail-closed), y no se cachea el fallo.
  if (error || !data?.valor) return null;
  cache = { value: data.valor as string, loadedAt: Date.now() };
  return cache.value;
}

/**
 * Devuelve null si la llamada está autorizada, o la Response 401 a devolver.
 * El cuerpo es genérico: no revela si falta el header, el secreto o la tabla.
 */
export async function authorizeInternal(req: Request, supabase: SupabaseClient): Promise<Response | null> {
  const provided = req.headers.get(INTERNAL_SECRET_HEADER);
  const expected = provided ? await loadSecret(supabase) : null;
  if (isInternalSecretValid(provided, expected)) return null;
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
