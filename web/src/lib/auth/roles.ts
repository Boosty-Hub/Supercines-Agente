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
// Ahora un valor presente pero irreconocible cae CERRADO (SIN_ACCESO), igual que la
// RLS (0078/0079): ninguna capa abre nada con un valor que no reconoce.
//
// ── SIN ROL = SIN ACCESO ─────────────────────────────────────────────────
//
// Hasta acá la AUSENCIA de rol abría TODO ("es el maestro del /first-run"). Era
// un fallo abierto con disparador externo: con el registro público de Supabase
// Auth habilitado (el default de un proyecto nuevo), cualquiera con la anon key
// (pública) hacía `signUp` y nacía SIN rol → alcance configuracion → panel
// entero, credenciales y usuarios incluidos. Ahora:
//
//   - Sin rol ⇒ SIN_ACCESO: el middleware no le deja ver NADA del panel salvo
//     /sin-acceso (aviso + cerrar sesión) y las rutas de sesión (/auth/*).
//     Ninguna ruta de API le responde, ni las que no tienen alcance declarado.
//   - Se eligió SIN_ACCESO y no `operacion`: un usuario sin rol no es un dato
//     corrupto de alguien legítimo, es alguien que nadie dio de alta (o un
//     alta a medias). `operacion` igual le mostraría todos los leads y las
//     conversaciones (PII de clientes). Lo legítimo siempre tiene rol: el
//     /first-run crea al maestro con `configuracion` explícito, `/usuarios`
//     rechaza crear sin alcance, y la migración de datos que acompaña a este
//     cambio asigna `configuracion` a los usuarios que ya existían sin rol
//     (deploy: esa migración ANTES que esta web, o el maestro viejo se queda
//     afuera hasta que corra).
//   - La RLS dice lo mismo (sin rol = sin acceso): el mismo contrato en las
//     dos capas.
//
// ── DOS FRONTERAS DISTINTAS, NO CONFUNDIR UNA CON LA OTRA ────────────────
//
//   1) La de RUTAS (este archivo) es real y la aplica el middleware en cada
//      request, de página y de API, antes de que el componente o el handler
//      corran. Ocultar un ítem del menú NO es un permiso: la ruta se sigue
//      alcanzando escribiendo la URL.
//   2) La de DATOS (RLS, migraciones 0078/0079): un usuario con sesión puede
//      pegarle directo a PostgREST con la anon key (pública por diseño) y su
//      JWT, saltándose esta capa. Por eso la base también decide: runtime_config,
//      kommo_credentials y alert_config son solo del servidor (service_role), y
//      las tablas de config/contenido exigen el alcance en la policy con la
//      condición INLINE sobre `app_metadata.role` que copia EXACTAMENTE
//      `getScope`/`scopeAlcanza` de acá (sin rol → sin acceso; admin/editor
//      como alias; irreconocible → sin acceso). Si cambia esta regla, cambia la de
//      las policies en una migración nueva: una discrepancia entre las dos capas
//      es peor que no tener la segunda. Matriz tabla × alcance en CLAUDE.md;
//      la prueba es supabase/tests/runtime_config_lockdown.sql.

export type Scope = "operacion" | "contenido" | "configuracion";

/** Usuario autenticado SIN rol asignado: no entra a nada del panel. No es un `Scope`. */
export const SIN_ACCESO = "sin_acceso" as const;

/** Lo que resuelve `getScope`: un alcance real o SIN_ACCESO. */
export type Alcance = Scope | typeof SIN_ACCESO;

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

/** Etiqueta de un usuario sin rol en /usuarios (no es un alcance que se pueda elegir). */
export const SIN_ACCESO_LABEL = "Sin acceso";

/**
 * El alcance real de este usuario. Única fuente de verdad.
 *
 * Sin rol (ausente, null o "") ⇒ SIN_ACCESO. Ver «SIN ROL = SIN ACCESO» arriba.
 */
/** ¿El usuario NO tiene rol (ausente, null o "")? Distinto de un rol presente pero irreconocible. */
export function esSinRol(user: UserLike): boolean {
  const r = user?.app_metadata?.role;
  return r === null || r === undefined || r === "";
}

export function getScope(user: UserLike): Alcance {
  const r = user?.app_metadata?.role;

  if (r === null || r === undefined || r === "") return SIN_ACCESO;

  // Alias heredados.
  if (r === "admin") return "configuracion";
  if (r === "editor") return "contenido";

  if (isScope(r)) return r;

  // Presente pero irreconocible: cae CERRADO, igual que en SQL (las policies de 0078/0079 solo
  // abren con valores reconocidos). Un valor corrupto no abre NADA, ni siquiera `operacion`:
  // TS y RLS en desacuerdo darían páginas vacías o acceso a medias.
  return SIN_ACCESO;
}

/** ¿El alcance de este usuario alcanza para lo que se le pide? Acumulativo. SIN_ACCESO nunca. */
export function scopeAlcanza(deUsuario: Alcance, requerido: Scope): boolean {
  if (deUsuario === SIN_ACCESO) return false;
  return SCOPE_RANK[deUsuario] >= SCOPE_RANK[requerido];
}

/**
 * ¿Pasar de `antes` a `despues` le QUITA acceso? (Al bajar el alcance se revocan las sesiones
 * del usuario: un JWT ya emitido seguiría valiendo con el alcance viejo hasta expirar.)
 * Subir desde SIN_ACCESO no es una baja; el mismo alcance tampoco.
 */
export function esBajaDeAlcance(antes: Alcance, despues: Scope): boolean {
  if (antes === SIN_ACCESO) return false;
  return SCOPE_RANK[despues] < SCOPE_RANK[antes];
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
  { prefix: "/api/inbox", scope: "operacion" }, // lista/tablero y sincronización con Kommo
  // Mover un lead de etapa desde el tablero. Operación: es lo mismo que la persona
  // ya hace a mano en Kommo. Subirlo a "contenido" si se quiere restringir.
  { prefix: "/api/leads", scope: "operacion" },
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
  { prefix: "/salesbots", scope: "contenido" }, // funnel de los Salesbots de Kommo (solo lectura)
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
  // Excepción dentro de /api/usage: leer el consumo es contenido y calidad,
  // pero POST /api/usage/models CAMBIA el modelo de producción y sincroniza el
  // Managed Agent en Anthropic. Eso es configuración del agente, no una métrica.
  { prefix: "/api/usage/models", scope: "configuracion" },
  // Ídem POST /api/usage/budget: fija el techo de gasto mensual, que FRENA el
  // pipeline en producción (al 100% deja de generar respuestas y seguimientos, al
  // 110% deja de clasificar). Es un kill switch por gasto: configuración.
  { prefix: "/api/usage/budget", scope: "configuracion" },
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
  // Recuperación de plataforma desde la franja de incidentes: omitir la cola atascada,
  // silenciar la franja. VER la franja lo hace cualquiera; ACTUAR exige configuración.
  { prefix: "/api/incidents", scope: "configuracion" },
  { prefix: "/api/provision", scope: "configuracion" },
  // /api/routing no existe en el template: switches de ruteo de leads
  // (kill switch, confianza mínima, asignados) editados desde
  // Ajustes → Agente → Routing. Mismo criterio que /api/kommo.
  { prefix: "/api/routing", scope: "configuracion" },
];

function coincide(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/**
 * El alcance mínimo que exige esta ruta, o `null` si no está restringida.
 *
 * GANA EL PREFIJO MÁS LARGO, no el primero de la lista. Es lo que permite una
 * excepción más estricta dentro de un grupo laxo —`/api/usage` es `contenido`
 * pero `/api/usage/models` y `/api/usage/budget` son `configuracion`, porque
 * cambian el modelo de producción / el techo que frena el pipeline— sin que el resultado
 * dependa del ORDEN del array. Con `find()` bastaba con reordenar la lista para
 * degradar una ruta en silencio, y ese es justo el fallo que no se ve.
 */
export function scopeRequeridoPara(pathname: string): Scope | null {
  let mejor: { prefix: string; scope: Scope } | null = null;
  for (const entrada of PATH_SCOPES) {
    if (!coincide(pathname, entrada.prefix)) continue;
    if (!mejor || entrada.prefix.length > mejor.prefix.length) mejor = entrada;
  }
  return mejor ? mejor.scope : null;
}

/**
 * Lo único que ve un usuario autenticado SIN_ACCESO: el aviso y las rutas de sesión (cerrar
 * sesión, callback). Todo lo demás —páginas, API, incluso lo que no tiene alcance declarado— no.
 *
 * Excepción de TRANSICIÓN: `/api/provision/migrate` pasa el middleware para que el maestro sin
 * rol de un despliegue anterior pueda aplicar la migración que le asigna el rol (SuperCines no
 * tiene `/api/provision/updates`). La ruta decide (lib/provision/gate.ts): solo mientras esa migración (0078) no
 * esté aplicada; después responde 403 como a cualquier otro sin rol.
 */
export const RUTA_SIN_ACCESO = "/sin-acceso";
const PERMITIDAS_SIN_ACCESO = [RUTA_SIN_ACCESO, "/auth", "/api/provision/migrate"];

/**
 * ¿Este alcance alcanza para esta ruta? La pregunta que hace cumplir el
 * middleware — pura y sin depender de la sesión ni del request.
 */
export function rutaPermitida(alcance: Alcance, pathname: string): boolean {
  if (alcance === SIN_ACCESO) return PERMITIDAS_SIN_ACCESO.some((p) => coincide(pathname, p));
  const requerido = scopeRequeridoPara(pathname);
  return requerido === null || scopeAlcanza(alcance, requerido);
}

/** A dónde mandar a un usuario con sesión cuando una página no le corresponde. */
export function inicioPara(alcance: Alcance): string {
  return alcance === SIN_ACCESO ? RUTA_SIN_ACCESO : "/inbox";
}
