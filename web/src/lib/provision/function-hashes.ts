// lib/provision/function-hashes.ts
// Tracks the content hash of each Edge Function that was last deployed, so the
// update center can detect which functions CHANGED (not just which are missing).
// Stored as a single JSON map in runtime_config under DEPLOYED_FUNCTION_HASHES.
//
// INVARIANT: this module MUST NOT import runtime-config.ts or service.ts.
// It builds an inline @supabase/supabase-js client (the table may be absent
// pre-migration, so all ops tolerate absence gracefully).

import { createClient } from "@supabase/supabase-js";

const KEY = "DEPLOYED_FUNCTION_HASHES";

function makeClient(supabaseUrl: string, serviceRoleKey: string) {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/** Read the {slug: hash} map of last-deployed function hashes. {} if none. */
export async function readDeployedHashes(
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<Record<string, string>> {
  try {
    const supabase = makeClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase
      .from("runtime_config")
      .select("value")
      .eq("key", KEY)
      .maybeSingle();
    if (error) return {};
    const raw = data?.value as string | null | undefined;
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  } catch {
    return {};
  }
}

/** Record (upsert) the deployed hash for one function slug. Tolerates absence. */
export async function saveDeployedHash(
  supabaseUrl: string,
  serviceRoleKey: string,
  slug: string,
  hash: string
): Promise<void> {
  try {
    const current = await readDeployedHashes(supabaseUrl, serviceRoleKey);
    current[slug] = hash;
    const supabase = makeClient(supabaseUrl, serviceRoleKey);
    await supabase.from("runtime_config").upsert(
      { key: KEY, value: JSON.stringify(current), updated_by: "update-center" },
      { onConflict: "key" }
    );
  } catch {
    // best-effort
  }
}
