// _shared/config.ts
// Shared runtime-config reader for Edge Functions.
//
// Reads ALL rows from the `runtime_config` table once per cold-start (or
// after the 60-second TTL expires) and caches the result in module scope —
// the same idiom used by `verticalsCache` in process-inbound.
//
// PRECEDENCE RULE (mirrors the web reader):
//   1. runtime_config.value WHERE key=K, if row IS NOT NULL AND != '' → use it.
//   2. Otherwise Deno.env.get(key) → use it.
//   3. Otherwise undefined.
//
// A NULL or empty DB value is treated as ABSENT. This guarantees:
//   - Empty table (bootstrap / pre-wizard) → env wins → same as today.
//   - Wizard-populated table → DB wins → no need to redeploy Edge Functions.
//
// Usage:
//   import { loadConfig } from "../_shared/config.ts";
//   const cfg = await loadConfig(supabase);
//   const apiKey = cfg.require("ANTHROPIC_API_KEY");
//   const operator = cfg.getOr("OPERATOR_NAME", "el operador");

// deno-lint-ignore-file no-explicit-any
import { isDbOnlySecretKey } from "./db-only-secret-keys.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export interface ConfigReader {
  /** DB-first, then Deno.env.get() fallback. Returns undefined if absent everywhere. */
  get(key: string): string | undefined;
  /**
   * SOLO la tabla runtime_config, sin fallback a Deno.env. Para lo que el operador decide
   * desde el panel y no debe poder caer en un secreto del entorno de las funciones: los
   * {{CLAVE}} de los headers de las http tools (una clave ausente en la base no puede
   * resolverse con un secret de Supabase con el mismo nombre).
   */
  getDbOnly(key: string): string | undefined;
  /** Like get() but throws if the resolved value is absent. */
  require(key: string): string;
  /** Like get() but returns `fallback` if the resolved value is absent. */
  getOr(key: string, fallback: string): string;
}

// Module-level cache — survives warm invocations, refreshes within 60s of a
// wizard save (same TTL idiom as verticalsCache in process-inbound).
let configCache: { map: Record<string, string>; loadedAt: number } | null = null;
const CONFIG_TTL_MS = 60_000;

async function loadConfigMap(supabase: SupabaseClient): Promise<Record<string, string>> {
  if (configCache && Date.now() - configCache.loadedAt < CONFIG_TTL_MS) {
    return configCache.map;
  }
  const { data, error } = await (supabase as any)
    .from("runtime_config")
    .select("key, value");
  if (error) {
    // On error (e.g. table not yet migrated) fall through to env-only mode.
    console.warn("runtime_config read error — falling back to env:", error.message);
    configCache = { map: Object.create(null), loadedAt: Date.now() };
    return configCache.map;
  }
  // Prototipo nulo: una clave como "constructor" o "__proto__" (de una fila o de una
  // plantilla {{...}}) no puede resolver a algo heredado de Object.prototype.
  const map: Record<string, string> = Object.create(null);
  for (const row of (data ?? []) as Array<{ key: string; value: string | null }>) {
    // Only store non-null, non-empty values — absent/null means "use env".
    if (row.value !== null && row.value !== "") {
      map[row.key] = row.value;
    }
  }
  configCache = { map, loadedAt: Date.now() };
  return map;
}

export async function loadConfig(supabase: SupabaseClient): Promise<ConfigReader> {
  const map = await loadConfigMap(supabase);
  return createConfigReader(map, (k) => Deno.env.get(k));
}

/**
 * Lector sobre un mapa ya cargado (puro: el entorno entra como función, para testearlo).
 * Solo cuentan las propiedades PROPIAS del mapa y los valores no vacíos.
 */
export function createConfigReader(
  map: Record<string, string>,
  envGet: (key: string) => string | undefined
): ConfigReader {
  const getDbOnly = (key: string): string | undefined => {
    if (!Object.hasOwn(map, key)) return undefined;
    const dbValue = map[key];
    return typeof dbValue === "string" && dbValue.trim() !== "" ? dbValue : undefined;
  };

  // Los secretos atados a un destino (KOMMO_ACCESS_TOKEN, SHOPIFY_*, BCV_RATE_APIKEY, TOOL_<X>) viven
  // SOLO en runtime_config: sin fallback a Deno.env (ver _shared/db-only-secret-keys.ts).
  const get = (key: string): string | undefined =>
    getDbOnly(key) ?? (isDbOnlySecretKey(key) ? undefined : envGet(key)) ?? undefined;

  const require = (key: string): string => {
    const v = get(key);
    if (!v) throw new Error(`Config key "${key}" is required but not set in runtime_config or env.`);
    return v;
  };

  const getOr = (key: string, fallback: string): string => {
    return get(key) ?? fallback;
  };

  return { get, getDbOnly, require, getOr };
}
