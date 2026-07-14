// server-only: this module must only be imported in server-side code.
// Creates a service-role Supabase client that bypasses RLS.
// Used by runtime-config.ts to read secret keys without a user session.
import { createClient } from "@supabase/supabase-js";

export function createServiceClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) is not set");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}
