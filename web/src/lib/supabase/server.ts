import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { EMBED_COOKIE_OPTIONS } from "./cookie-options";

export function createSupabaseServerClient() {
  const cookieStore = cookies();
  // When embedded (embed_mode cookie set by the middleware), the session cookies
  // must carry CHIPS attrs so they survive the Hub's cross-site iframe.
  const embed = cookieStore.get("embed_mode")?.value === "1";
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(embed ? { cookieOptions: EMBED_COOKIE_OPTIONS } : {}),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Llamado desde Server Component — el middleware refresca la sesión.
          }
        },
      },
    }
  );
}
