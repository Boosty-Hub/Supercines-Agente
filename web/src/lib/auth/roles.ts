// Alcances del panel. El alcance vive en Supabase Auth `app_metadata.role`
// (solo escribible con service-role), así viaja en el JWT y se lee sin
// round-trip a la base.
//
// ── TRES ALCANCES, ACUMULATIVOS ──────────────────────────────────────────
//
//   operacion     → solo el grupo Operación (inbox, leads, alertas)
//   contenido     → + Contenido y calidad (contenido, promos, verticales…)
//   configuracion → + Configuración (credenciales, Kommo, usuarios, ajustes…)
//
// Antes eran dos ("admin" y "editor") y no alcanzaba: quien atiende
// conversaciones, quien edita contenido y quien puede tocar el interruptor
// que enciende al agente son tres personas distintas en cualquier operación
// que crezca más allá de una sola.
//
// "admin" y "editor" siguen siendo alias válidos y significan exactamente lo
// que significaban: "admin" es acceso total (→ configuracion) y "editor" es
// Operación + Contenido y calidad, nunca Configuración (→ contenido). Ningún
// usuario existente gana ni pierde acceso al adoptar este módulo.
//
// ── EL VALOR DESCONOCIDO CAE CERRADO ─────────────────────────────────────
//
// La versión anterior hacía `r === "editor" ? "editor" : "admin"`: cualquier
// valor que no fuera exactamente "editor" —un typo, "Editor" con mayúscula,
// un dato corrupto, un alcance que este módulo todavía no conoce— REGALABA
// ACCESO TOTAL. Un fallo abierto en el punto exacto donde no puede haberlo.
//
// Ahora un valor presente pero irreconocible cae al alcance MÁS RESTRICTIVO.
// Lo único que abre del todo es la AUSENCIA de rol, y eso es deliberado y
// acotado: es el usuario maestro que crea el wizard `/first-run`, anterior a
// este módulo. Crear un usuario desde `/usuarios` SIEMPRE fija un alcance, así
// que "sin rol" nunca es el estado de un usuario nuevo.
//
// ── DOS FRONTERAS DISTINTAS, NO CONFUNDIR UNA CON LA OTRA ────────────────
//
//   1) La de RUTAS (este archivo) es real y la aplica el middleware en cada
//      request, de página y de API, antes de que el componente o el handler
//      corran. Ocultar un ítem del menú NO es un permiso: la ruta se sigue
//      alcanzando escribiendo la URL.
//   2) La de DATOS no existe todavía. La RLS de las tablas sigue siendo
//      `authenticated_all`, así que cualquier usuario con sesión —sea el
//      alcance que sea— puede, en teoría, pegarle directo a PostgREST con la
//      anon key (que es pública por diseño) y su propio JWT, saltándose esta
//      capa entera. Cerrarlo exige políticas RLS por alcance en la base, con
//      funciones que copien EXACTAMENTE `getScope`/`scopeAlcanza` de acá: una
//      discrepancia entre las dos capas sería peor que no tener la segunda,
//      porque daría por protegido lo que no lo está.

export type Scope = "operacion" | "contenido" | "configuracion";

/** Los dos alias heredados. Se siguen leyendo; ya no se escriben. */
export type Role = "admin" | "editor";

export const SCOPES: readonly Scope[] = ["operacion", "contenido", "configuracion"];

const SCOPE_RANK: Record<Scope, number> = {
  operacion: 0,
  contenido: 1,
  configuracion: 2,
};

/** Etiqueta y descripción para la UI de /usuarios. Una sola fuente. */
export const SCOPE_LABEL: Record<Scope, string> = {
  operacion: "Operación",
  contenido: "Contenido",
  configuracion: "Administrador",
};

export const SCOPE_DESC: Record<Scope, string> = {
  operacion: "Atiende conversaciones: Inbox, Leads y Alertas. No edita contenido ni configuración.",
  contenido:
    "Todo lo de Operación, más contenido y calidad (contenido, promos, verticales, outcomes, dreams). No toca credenciales, encendido del agente ni usuarios.",
  configuracion: "Acceso total, incluidas credenciales, encendido del agente y gestión de usuarios.",
};

type UserLike = { app_metadata?: Record<string, unknown> | null } | null | undefined;

export function isScope(v: unknown): v is Scope {
  return v === "operacion" || v === "contenido" || v === "configuracion";
}

/**
 * El alcance real de este usuario. Única fuente de verdad — `getRole` se
 * deriva de esto, nunca al revés.
 */
export function getScope(user: UserLike): Scope {
  const r = user?.app_metadata?.role;

  // Sin rol explícito: el maestro del first-run. Acceso total, a propósito.
  if (r === null || r === undefined) return "configuracion";

  // Alias heredados.
  if (r === "admin") return "configuracion";
  if (r === "editor") return "contenido";

  if (isScope(r)) return r;

  // Presente pero irreconocible: cae CERRADO. Ver la nota de arriba — un
  // valor corrupto no es lo mismo que un valor ausente.
  return "operacion";
}

/**
 * Compat hacia atrás para código que todavía razona en admin/editor.
 * Derivado de `getScope`: "configuracion" es admin, todo lo demás editor.
 */
export function getRole(user: UserLike): Role {
  return getScope(user) === "configuracion" ? "admin" : "editor";
}

/** ¿El alcance de este usuario alcanza para lo que se le pide? Acumulativo. */
export function scopeAlcanza(deUsuario: Scope, requerido: Scope): boolean {
  return SCOPE_RANK[deUsuario] >= SCOPE_RANK[requerido];
}

// Alcance mínimo por prefijo de ruta. Reemplaza la lista binaria que existía
// antes (admin-only vs. "todo lo demás"): ese "todo lo demás" se separa ahora
// en Operación y Contenido y calidad, la misma distinción que la barra lateral
// ya dibujaba pero que el middleware nunca llegó a exigir.
//
// MANTENER EXHAUSTIVA. Una ruta que no aparezca acá NO queda protegida: queda
// abierta a cualquier alcance, incluido `operacion`. Al agregar una página o
// una ruta de API nueva, agregar acá su entrada en el mismo commit.
const PATH_SCOPES: ReadonlyArray<{ readonly prefix: string; readonly scope: Scope }> = [
  // ── Operación ──────────────────────────────────────────────────────────
  { prefix: "/inbox", scope: "operacion" },
  { prefix: "/leads", scope: "operacion" },
  { prefix: "/alerts", scope: "operacion" },
  { prefix: "/api/messages", scope: "operacion" },
  { prefix: "/api/drafts", scope: "operacion" },
  { prefix: "/api/alerts", scope: "operacion" },

  // ── Contenido y calidad ────────────────────────────────────────────────
  { prefix: "/contenido", scope: "contenido" },
  { prefix: "/promos", scope: "contenido" },
  { prefix: "/verticales", scope: "contenido" },
  { prefix: "/outcomes", scope: "contenido" },
  { prefix: "/consumo", scope: "contenido" },
  { prefix: "/status", scope: "contenido" }, // muestra el costo en USD, igual que /consumo
  { prefix: "/dreams", scope: "contenido" },
  { prefix: "/kb", scope: "contenido" }, // redirige a /contenido?tab=kb
  { prefix: "/voz", scope: "contenido" }, // redirige a /contenido?tab=voz
  { prefix: "/api/kb", scope: "contenido" },
  { prefix: "/api/voz", scope: "contenido" },
  { prefix: "/api/promotions", scope: "contenido" },
  { prefix: "/api/situations", scope: "contenido" },
  { prefix: "/api/verticales", scope: "contenido" },
  { prefix: "/api/graders", scope: "contenido" },
  { prefix: "/api/usage", scope: "contenido" },
  { prefix: "/api/dreams", scope: "contenido" },

  // ── Configuración ──────────────────────────────────────────────────────
  // Credenciales, kill switches, Kommo, herramientas, seguimiento, usuarios,
  // setup: todo lo que cambia cómo opera el agente o expone un secreto.
  // /agent, /config y /tools ya solo redirigen a /settings (Agente, Kommo y
  // Herramientas viven ahí como pestañas), pero se dejan listados para que un
  // usuario sin alcance `configuracion` no llegue ni al redirect.
  { prefix: "/agent", scope: "configuracion" },
  { prefix: "/config", scope: "configuracion" },
  { prefix: "/tools", scope: "configuracion" },
  { prefix: "/seguimiento", scope: "configuracion" },
  { prefix: "/settings", scope: "configuracion" },
  { prefix: "/setup", scope: "configuracion" },
  { prefix: "/usuarios", scope: "configuracion" },
  { prefix: "/api/agent", scope: "configuracion" },
  { prefix: "/api/agent-off", scope: "configuracion" },
  { prefix: "/api/setup", scope: "configuracion" },
  { prefix: "/api/settings", scope: "configuracion" },
  { prefix: "/api/tools", scope: "configuracion" },
  { prefix: "/api/follow-up", scope: "configuracion" },
  { prefix: "/api/users", scope: "configuracion" },
  { prefix: "/api/filters", scope: "configuracion" },
  { prefix: "/api/skip-rules", scope: "configuracion" },
  { prefix: "/api/response-debounce", scope: "configuracion" },
  { prefix: "/api/response-freshness", scope: "configuracion" },
  { prefix: "/api/response-limits", scope: "configuracion" },
  { prefix: "/api/media-response", scope: "configuracion" },
  { prefix: "/api/kommo", scope: "configuracion" },
  { prefix: "/api/provision", scope: "configuracion" },
  // /api/routing no existe en el template: switches de ruteo de leads
  // (kill switch, confianza mínima, asignados) editados desde
  // Ajustes → Agente → Routing. Mismo criterio que /api/kommo.
  { prefix: "/api/routing", scope: "configuracion" },
];

function coincide(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** El alcance mínimo que exige esta ruta, o `null` si no está restringida. */
export function scopeRequeridoPara(pathname: string): Scope | null {
  const entrada = PATH_SCOPES.find(({ prefix }) => coincide(pathname, prefix));
  return entrada ? entrada.scope : null;
}

/**
 * ¿Este alcance alcanza para esta ruta? La pregunta que hace cumplir el
 * middleware — pura y sin depender de la sesión ni del request.
 */
export function rutaPermitida(scope: Scope, pathname: string): boolean {
  const requerido = scopeRequeridoPara(pathname);
  return requerido === null || scopeAlcanza(scope, requerido);
}
