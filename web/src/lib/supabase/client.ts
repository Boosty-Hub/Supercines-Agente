import { createBrowserClient } from "@supabase/ssr";
import { EMBED_COOKIE_OPTIONS, isEmbeddedContext } from "./cookie-options";

// Placeholder values used ONLY when Supabase env is absent (e.g. the first
// build/deploy before the host env vars are set). They let the bundle build
// and the auth pages prerender without crashing. They are never exercised at
// runtime: when env is missing the middleware redirects every non-allowlisted
// route to /first-run, so /login, /update-password and /auth/callback are
// never interactively reached without real credentials.
const PLACEHOLDER_URL = "https://placeholder.supabase.co";
const PLACEHOLDER_ANON = "placeholder-anon-key";

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || PLACEHOLDER_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || PLACEHOLDER_ANON;
  // Inside the Hub's cross-site iframe, the session cookie needs CHIPS attrs
  // (SameSite=None; Secure; Partitioned) or it won't persist — see cookie-options.
  return createBrowserClient(
    url,
    anon,
    isEmbeddedContext() ? { cookieOptions: EMBED_COOKIE_OPTIONS } : undefined
  );
}
