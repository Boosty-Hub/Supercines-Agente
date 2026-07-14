import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getRole, isAdminOnlyPath } from "@/lib/auth/roles";
import { EMBED_COOKIE_OPTIONS } from "./cookie-options";

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── NO-ENV GUARD ─────────────────────────────────────────────────────────
  // When Supabase env vars are absent the app is not yet connected.
  // Allow static assets, the first-run wizard pages, and provision API routes
  // to pass through; redirect everything else to /first-run.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const isPublicAsset =
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/api/provision") ||
    pathname.startsWith("/first-run");

  if (!url || !anon) {
    if (isPublicAsset) {
      return NextResponse.next({ request });
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/first-run";
    return NextResponse.redirect(redirectUrl, { status: 307 });
  }
  // ── END NO-ENV GUARD ─────────────────────────────────────────────────────

  // Both env vars are confirmed defined — build the client with locals (no !)
  let supabaseResponse = NextResponse.next({ request });

  // Embed context (computed early so the refreshed session cookies get CHIPS
  // attrs and survive the Hub's cross-site iframe — see cookie-options).
  const requestedMode = request.nextUrl.searchParams.get("mode");
  const embedActive = requestedMode === "embed" || request.cookies.get("embed_mode")?.value === "1";

  const supabase = createServerClient(url, anon, {
    ...(embedActive ? { cookieOptions: EMBED_COOKIE_OPTIONS } : {}),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Rutas públicas (post-connection)
  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/api/provision") ||
    pathname.startsWith("/first-run");

  if (!user && !isPublic) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    return NextResponse.redirect(redirectUrl);
  }

  if (user && pathname === "/login") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/inbox";
    return NextResponse.redirect(redirectUrl);
  }

  // ── ROLE GATE ──────────────────────────────────────────────────────────────
  // Los "editor" no acceden a la configuración (credenciales, kill switches,
  // Kommo, herramientas, seguimiento, ajustes, setup) ni a la gestión de
  // usuarios. Enforcement centralizado por prefijo de ruta. Los usuarios sin rol
  // explícito (el master) son admin por default.
  if (user && getRole(user) === "editor" && isAdminOnlyPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "forbidden: requiere rol admin" }, { status: 403 });
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/inbox";
    return NextResponse.redirect(redirectUrl);
  }

  // Modo embed: activa la UI de tabs al cargar con ?mode=embed, desactiva con ?mode=normal
  const mode = request.nextUrl.searchParams.get("mode");
  const embedCookie = request.cookies.get("embed_mode")?.value === "1";

  if (mode === "embed") {
    // CHIPS attrs so this cookie itself survives the Hub's cross-site iframe —
    // a SameSite=Lax cookie is dropped there, and everything downstream keys off
    // embed_mode to keep the embed CSP + session cookies active.
    supabaseResponse.cookies.set("embed_mode", "1", {
      path: "/",
      httpOnly: true,
      ...EMBED_COOKIE_OPTIONS,
    });
  } else if (mode === "normal") {
    supabaseResponse.cookies.delete("embed_mode");
  }

  // Cuando embed está activo, sobreescribir el CSP para permitir el iframe.
  // Solo se activa cuando el usuario lo pidió explícitamente — sin esto el
  // header por defecto es frame-ancestors 'self' (seguro).
  if (mode === "embed" || embedCookie) {
    // Sanitizar para prevenir header injection
    const raw = process.env.EMBED_ORIGINS || "*";
    const origins = raw.replace(/[\r\n]/g, "");
    supabaseResponse.headers.set(
      "Content-Security-Policy",
      `frame-ancestors ${origins}`
    );
  }

  return supabaseResponse;
}
