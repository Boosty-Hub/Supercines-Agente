// server-only: this module must only be imported in server-side code.
// Reads runtime_config table via service-role client.
//
// SECURITY (migración 0079): runtime_config NO es legible ni escribible con la sesión del
// usuario (ni anon ni authenticated tienen privilegio). La única vía es este módulo, con el
// cliente de servicio, desde rutas/páginas que YA validaron sesión + alcance
// (lib/auth/require-scope.ts). Escribir exige un ConfigWriter (solo lo fabrica requireScope)
// y se valida clave por clave (lib/config-secrets.ts#configKeysDenied). Los valores
// secretos nunca se devuelven al navegador: ver lib/config-secrets.ts (configView/maskSecret).
//
// PRECEDENCE RULE (same as Edge _shared/config.ts):
//   1. runtime_config.value WHERE key=K, if NOT NULL AND != '' → use it.
//   2. Otherwise process.env[key].
//   3. Otherwise undefined.
//
// Cache: React cache() provides per-request memoization so we only hit
// the DB once per server component tree, regardless of how many times
// getRuntimeConfig() / configValue() are called.

import "server-only";
import { isDbOnlySecretKey } from "@/lib/db-only-secret-keys";
import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/service";
import { configKeysDenied, isSecretConfigKey } from "@/lib/config-secrets";
import type { ConfigWriter } from "@/lib/auth/scope-guard";
import { checkSecretBindings, keysToCheck, type SecretBindingViolation } from "@/lib/secret-bound-config";

/** Se intentó escribir una clave que el alcance del que escribe no permite. */
export class ConfigWriteForbiddenError extends Error {
  constructor(readonly keys: string[]) {
    super(`Sin alcance para escribir: ${keys.join(", ")}`);
    this.name = "ConfigWriteForbiddenError";
  }
}

/**
 * La escritura cambia el destino de un par destino + secreto sin reenviar el secreto
 * (lib/secret-bound-config.ts). Las rutas la traducen a un 400.
 */
export class SecretBindingError extends Error {
  constructor(readonly violations: SecretBindingViolation[]) {
    super(violations.map((v) => v.message).join(" "));
    this.name = "SecretBindingError";
  }
}

type ConfigRow = { key: string; value: string | null };

/**
 * Returns the full runtime_config map for the current request.
 * Memoized per request via React cache().
 */
export const getRuntimeConfig = cache(async (): Promise<Record<string, string>> => {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("runtime_config")
    .select("key, value");

  if (error) {
    // On error (table not yet migrated, etc.) fall through to env-only mode.
    console.warn("runtime_config read error — falling back to env:", error.message);
    return {};
  }

  const map: Record<string, string> = Object.create(null); // sin herencia de Object.prototype
  for (const row of (data ?? []) as ConfigRow[]) {
    if (row.value !== null && row.value !== "") {
      map[row.key] = row.value;
    }
  }
  return map;
});

/**
 * Fallback al entorno de la web. Los secretos atados a un destino (KOMMO_ACCESS_TOKEN, SHOPIFY_*,
 * BCV_RATE_APIKEY, TOOL_<X>) NO lo tienen: viven solo en runtime_config (lib/db-only-secret-keys.ts).
 */
function envFallback(key: string): string | undefined {
  return isDbOnlySecretKey(key) ? undefined : process.env[key] ?? undefined;
}

/**
 * Resolves a single config key using DB-first / process.env fallback.
 * Returns undefined if absent in both sources.
 */
export async function configValue(key: string): Promise<string | undefined> {
  const map = await getRuntimeConfig();
  const dbValue = map[key];
  if (dbValue !== undefined && dbValue.trim() !== "") return dbValue;
  return envFallback(key);
}

/**
 * Resolves several keys at once (DB-first / env-fallback). Convenience for
 * server components and API routes that need a handful of values.
 */
export async function configValues<K extends string>(
  keys: readonly K[]
): Promise<Record<K, string | undefined>> {
  const map = await getRuntimeConfig();
  const out = {} as Record<K, string | undefined>;
  for (const key of keys) {
    const dbValue = map[key];
    out[key] =
      dbValue !== undefined && dbValue.trim() !== ""
        ? dbValue
        : envFallback(key);
  }
  return out;
}

/**
 * Igual que configValues pero SIN la memoización por request: consulta la tabla en el
 * momento. Para decisiones que dependen de lo que acaba de escribir esta misma request
 * u otra concurrente (p. ej. la línea base de la sincronización segura del prompt: hash
 * y versión registrados, que un sync paralelo o un rename pueden haber movido).
 */
export async function configValuesFresh<K extends string>(
  keys: readonly K[]
): Promise<Record<K, string | undefined>> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("runtime_config")
    .select("key, value")
    .in("key", [...keys]);
  if (error) throw new Error(`runtime_config read failed: ${error.message}`);
  const db = new Map<string, string | null>();
  for (const row of (data ?? []) as ConfigRow[]) db.set(row.key, row.value);
  const out = {} as Record<K, string | undefined>;
  for (const key of keys) {
    const v = db.get(key);
    out[key] = v !== undefined && v !== null && v.trim() !== "" ? v : envFallback(key);
  }
  return out;
}

/**
 * Valores de claves PÚBLICAS (lib/config-secrets.ts), SOLO de la tabla (sin fallback a env) y
 * consultando únicamente esas filas: nunca trae un secreto a memoria. Pedir una clave secreta
 * es un error de programación y lanza. Lo usa el probador de http tools, que no debe leer
 * ningún secreto (los valores de prueba los teclea el operador).
 */
export async function publicConfigValues<K extends string>(
  keys: readonly K[]
): Promise<Partial<Record<K, string>>> {
  const secret = keys.filter((k) => isSecretConfigKey(k));
  if (secret.length > 0) throw new Error(`publicConfigValues: claves secretas pedidas: ${secret.join(", ")}`);
  const out: Partial<Record<K, string>> = Object.create(null);
  if (keys.length === 0) return out;
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("runtime_config")
    .select("key, value")
    .in("key", [...keys]);
  if (error) throw new Error(`runtime_config read failed: ${error.message}`);
  for (const row of (data ?? []) as ConfigRow[]) {
    if ((keys as readonly string[]).includes(row.key) && row.value !== null && row.value.trim() !== "") {
      out[row.key as K] = row.value;
    }
  }
  return out;
}

/**
 * Upserts config values into runtime_config via the service-role client.
 * Empty-string / undefined values are written as NULL so the reader falls
 * back to env (never an intentional empty override — matches the precedence
 * rule documented in 0017_runtime_config.sql).
 *
 * NOTE: this writes through the service client and is request-scoped. Because
 * getRuntimeConfig() is memoized per request via React cache(), a write
 * followed by a read in the SAME request will see the stale cached map; write
 * last (then redirect / return) so the next request reads fresh values.
 */
export async function setConfigValues(
  values: Record<string, string | null | undefined>,
  writer: ConfigWriter
): Promise<void> {
  const denied = configKeysDenied(writer.scope, Object.keys(values));
  if (denied.length > 0) throw new ConfigWriteForbiddenError(denied);
  const updatedBy = writer.by;
  const supabase = createServiceClient();

  // Pares destino + secreto: cambiar el destino exige reenviar (o borrar) el secreto en esta
  // misma escritura. Se decide con los valores VIGENTES leídos ahora (base, o entorno si la
  // base no tiene), no con la memoización por request.
  const toCheck = keysToCheck(Object.keys(values));
  if (toCheck.length > 0) {
    const { data: currentRows, error: readErr } = await supabase
      .from("runtime_config")
      .select("key, value")
      .in("key", toCheck);
    if (readErr) throw new Error(`runtime_config read failed: ${readErr.message}`);
    const db = new Map<string, string>();
    for (const row of (currentRows ?? []) as ConfigRow[]) {
      if (row.value !== null && row.value.trim() !== "") db.set(row.key, row.value);
    }
    const env = (k: string): string | undefined => {
      const v = envFallback(k); // los secretos atados a un destino NO tienen fallback al entorno
      return v !== undefined && v.trim() !== "" ? v : undefined;
    };
    const violations = checkSecretBindings(values, (k) => db.get(k) ?? env(k), env);
    if (violations.length > 0) throw new SecretBindingError(violations);
  }

  const updatedAt = new Date().toISOString();
  const rows = Object.entries(values).map(([key, value]) => ({
    key,
    value: value === undefined || value === "" ? null : value,
    updated_at: updatedAt,
    updated_by: updatedBy,
  }));
  if (rows.length === 0) return;
  const { error } = await supabase
    .from("runtime_config")
    .upsert(rows, { onConflict: "key" });
  if (error) {
    throw new Error(`runtime_config write failed: ${error.message}`);
  }
}
