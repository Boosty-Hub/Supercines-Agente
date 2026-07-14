// Roles de usuario. El rol vive en Supabase Auth `app_metadata.role` (solo
// escribible con service-role), así viaja en el JWT y se lee sin round-trip.
//
// DEFAULT SEGURO + RETROCOMPAT: un usuario SIN rol explícito (el master creado
// en el first-run, anterior a este módulo) se trata como "admin". Crear un
// usuario por el módulo SIEMPRE fija un rol, así que "editor" nunca es implícito.
//
// NOTA DE SEGURIDAD: el enforcement es a nivel app (middleware + rutas). La RLS
// de la DB sigue siendo `authenticated_all`, por lo que un editor técnico con su
// anon-JWT podría, en teoría, pegarle directo a PostgREST. Endurecer con RLS por
// rol queda como iteración futura.

export type Role = "admin" | "editor";

export function getRole(
  user: { app_metadata?: Record<string, unknown> | null } | null | undefined
): Role {
  const r = user?.app_metadata?.role;
  return r === "editor" ? "editor" : "admin";
}

// Rutas reservadas a admin: el grupo "Configuración" (credenciales, kill
// switches, Kommo, herramientas, seguimiento, ajustes), el setup y la gestión de
// usuarios. Todo lo demás (operación + contenido/calidad) es editor-friendly.
const ADMIN_ONLY_PREFIXES = [
  // Páginas
  "/agent",
  "/config",
  "/tools",
  "/seguimiento",
  "/settings",
  "/setup",
  "/usuarios",
  // APIs de configuración / agente / kommo / seguimiento / setup / usuarios
  "/api/agent",
  "/api/agent-off",
  "/api/setup",
  "/api/settings",
  "/api/tools",
  "/api/follow-up",
  "/api/shopify",
  "/api/users",
  "/api/filters",
  "/api/skip-rules",
  "/api/response-debounce",
  "/api/response-freshness",
  "/api/response-limits",
  "/api/media-response",
  "/api/kommo",
  "/api/provision",
];

export function isAdminOnlyPath(pathname: string): boolean {
  return ADMIN_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
