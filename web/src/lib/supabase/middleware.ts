import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getScope, inicioPara, rutaPermitida, scopeRequeridoPara, SIN_ACCESO } from "@/lib/auth/roles";
import { jwtRoleDesfasado } from "@/lib/auth/jwt-role";
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

  // El rol del JWT (el que usa la RLS) puede haber quedado viejo: la migración que asigna
  // `configuracion` a los usuarios viejos sin rol, o un alcance subido en /usuarios. getUser() trae
  // el rol ACTUAL; si difiere del token, se refresca la sesión para no mostrar páginas vacías hasta
  // que el token expire (lib/auth/jwt-role.ts). Solo se refresca si difieren; un fallo no corta nada.
  if (user) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (jwtRoleDesfasado(session?.access_token, user.app_metadata?.role)) {
      await supabase.auth.refreshSession().catch(() => {});
    }
  }

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

  const alcance = user ? getScope(user) : null;

  if (alcance && pathname === "/login") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = inicioPara(alcance);
    return NextResponse.redirect(redirectUrl);
  }

  // ── SCOPE GATE ─────────────────────────────────────────────────────────────
  // Tres alcances acumulativos: operacion ⊂ contenido ⊂ configuracion. A qué
  // alcance pertenece cada ruta lo decide PATH_SCOPES en roles.ts — pura y
  // centralizada; acá solo se aplica. Vale para páginas Y para /api/*: ocultar
  // un ítem del menú no es un permiso, la ruta se sigue alcanzando escribiendo
  // la URL. Un usuario SIN rol no alcanza nada (SIN_ACCESO): solo /sin-acceso y
  // /auth/* (cerrar sesión). Vale también para las rutas "públicas" de arriba
  // (/first-run, /api/provision): con sesión, decide el alcance.
  if (alcance) {
    if (!rutaPermitida(alcance, pathname)) {
      if (pathname.startsWith("/api/")) {
        const error =
          alcance === SIN_ACCESO
            ? "forbidden: usuario sin alcance asignado"
            : `forbidden: requiere alcance ${scopeRequeridoPara(pathname) ?? "superior"}`;
        return NextResponse.json({ error }, { status: 403 });
      }
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = inicioPara(alcance);
      return NextResponse.redirect(redirectUrl);
    }
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
