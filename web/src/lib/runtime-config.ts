// server-only: this module must only be imported in server-side code.
// Reads runtime_config table via service-role client.
//
// PRECEDENCE RULE (same as Edge _shared/config.ts):
//   1. runtime_config.value WHERE key=K, if NOT NULL AND != '' → use it.
//   2. Otherwise process.env[key].
//   3. Otherwise undefined.
//
// Cache: React cache() provides per-request memoization so we only hit
// the DB once per server component tree, regardless of how many times
// getRuntimeConfig() / configValue() are called.

import { cache } from "react";
import { createServiceClient } from "@/lib/supabase/service";

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

  const map: Record<string, string> = {};
  for (const row of (data ?? []) as ConfigRow[]) {
    if (row.value !== null && row.value !== "") {
      map[row.key] = row.value;
    }
  }
  return map;
});

/**
 * Resolves a single config key using DB-first / process.env fallback.
 * Returns undefined if absent in both sources.
 */
export async function configValue(key: string): Promise<string | undefined> {
  const map = await getRuntimeConfig();
  const dbValue = map[key];
  if (dbValue !== undefined && dbValue.trim() !== "") return dbValue;
  return process.env[key] ?? undefined;
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
        : process.env[key] ?? undefined;
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
  updatedBy = "dashboard"
): Promise<void> {
  const supabase = createServiceClient();
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
