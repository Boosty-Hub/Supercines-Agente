// lib/provision/config-token.ts
// Read/write the Supabase Access Token (and other provision flags) from
// runtime_config using an inline Supabase client.
//
// INVARIANT: this module MUST NOT import runtime-config.ts or service.ts.
// It builds an inline @supabase/supabase-js client from caller-supplied
// credentials. The runtime_config table may not exist yet (pre-migration),
// so all operations tolerate absence gracefully.

import { createClient } from "@supabase/supabase-js";

const KEY = "SUPABASE_ACCESS_TOKEN";

/**
 * Build an inline service-role Supabase client without going through
 * the shared createServiceClient() (which would throw without env).
 */
function makeClient(supabaseUrl: string, serviceRoleKey: string) {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Persist the Supabase Personal Access Token into runtime_config.
 * Upserts the row (creates or updates). Tolerates table-absent errors
 * silently (returns false) — the table is created by migration 0017.
 *
 * @returns true on success, false if the table doesn't exist yet.
 */
export async function saveAccessToken(
  supabaseUrl: string,
  serviceRoleKey: string,
  token: string
): Promise<boolean> {
  try {
    const supabase = makeClient(supabaseUrl, serviceRoleKey);
    const { error } = await supabase.from("runtime_config").upsert(
      { key: KEY, value: token, updated_by: "provision-wizard" },
      { onConflict: "key" }
    );

    if (error) {
      // Table doesn't exist yet → tolerate silently
      if (
        error.message.includes("does not exist") ||
        error.code === "42P01"
      ) {
        return false;
      }
      throw error;
    }

    return true;
  } catch (err) {
    // If the error is about table absence, swallow it
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("42P01")) {
      return false;
    }
    throw err;
  }
}

/**
 * Read the stored Supabase Personal Access Token from runtime_config.
 * Returns null if not set or if the table doesn't exist.
 */
export async function readAccessToken(
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<string | null> {
  try {
    const supabase = makeClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase
      .from("runtime_config")
      .select("value")
      .eq("key", KEY)
      .maybeSingle();

    if (error) {
      // Table doesn't exist yet → return null
      if (
        error.message.includes("does not exist") ||
        error.code === "42P01"
      ) {
        return null;
      }
      throw error;
    }

    const value = data?.value as string | null | undefined;
    if (!value || value === "") return null;
    return value;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("42P01")) {
      return null;
    }
    throw err;
  }
}
