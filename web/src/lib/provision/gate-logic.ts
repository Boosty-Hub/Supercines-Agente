// lib/provision/gate-logic.ts — decisiones PURAS del acceso a /api/provision/* (las prueba
// lib/provision-gate.test.ts sin servidor). El I/O vive en lib/provision/gate.ts.
//
// INVARIANT: this module MUST NOT import runtime-config.ts or service.ts (ni nada con alias `@/`).
//
// El problema (C2): migrate / functions/deploy son públicas en el middleware porque el /first-run
// corre ANTES de que exista ningún usuario. Pero seguían públicas para siempre, tomaban el `ref`
// del body y, sin token en el body, usaban el `sbp_` GUARDADO en runtime_config. Ese token es de
// la CUENTA de Supabase (alcanza a todos sus proyectos): cualquiera sin sesión podía aplicar
// SQL/desplegar funciones con él contra el proyecto que eligiera.
//
// La regla:
//   - El `ref` NUNCA sale del body: siempre el del propio NEXT_PUBLIC_SUPABASE_URL.
//   - Sin usuarios Y sin el marcador «provisionada» = PRIMER ARRANQUE: se permite sin sesión, pero
//     solo con el token que el wizard manda en el body (el guardado no se usa). Provisionada sin
//     usuarios = recuperación manual (403): nunca se reabre desde la web anónima.
//   - Con al menos un usuario: sesión válida con alcance `configuracion` (401/403 si no). Recién
//     ahí se puede usar el token guardado.
//   - Si no se puede saber cuántos usuarios hay: CERRADO (503), nunca «primer arranque».

import { getRef } from "./ref.ts";

export type ProvisionMode = "first-boot" | "session";

export type ProvisionDecision =
  | { readonly ok: true; readonly mode: ProvisionMode }
  | { readonly ok: false; readonly status: 401 | 403 | 503; readonly error: string };

/** Lo que hay que hacer para recuperar una instalación provisionada que quedó sin usuarios. */
export const RECOVERY_HINT =
  "Esta instalación ya fue provisionada pero no tiene usuarios. Por seguridad el primer arranque no se reabre desde la web. " +
  "Recuperala desde Supabase: creá un usuario con app_metadata {\"role\":\"configuracion\"} en Authentication → Users (o por la Admin API) y entrá con él.";

/**
 * Primer paso: ¿hace falta sesión? `userCount` y `provisioned` son null cuando NO se pudieron leer
 * (Admin API / base caída): CERRADO (503), nunca «primer arranque».
 *
 * PRIMER ARRANQUE = sin usuarios Y sin el marcador persistente «provisionada» (lib/provision/
 * provisioned.ts). Contar usuarios solo no alcanza: si se borran todos (o quedan 0 por error) en una
 * instalación ya provisionada, el modo sin usuarios reabriría el provisioner y el register sin
 * sesión. Provisionada y sin usuarios = RECUPERACIÓN: la web anónima no la reabre; la recupera el
 * operador con un procedimiento documentado (RECOVERY_HINT).
 */
export function provisionNeedsSession(
  userCount: number | null,
  provisioned: boolean | null = false
): ProvisionDecision | "check-session" {
  if (userCount === null || provisioned === null) {
    return { ok: false, status: 503, error: "No se pudo verificar el estado de la instalación; reintentá." };
  }
  if (userCount > 0) return "check-session";
  if (provisioned) return { ok: false, status: 403, error: RECOVERY_HINT };
  return { ok: true, mode: "first-boot" };
}

/** De qué token se vale la operación: el del body, o el guardado SOLO con sesión. */
export function pickProvisionToken(
  mode: ProvisionMode,
  bodyToken: unknown,
  storedToken: string | null
): { ok: true; token: string } | { ok: false; error: string } {
  const fromBody = typeof bodyToken === "string" ? bodyToken.trim() : "";
  if (fromBody) return { ok: true, token: fromBody };
  if (mode === "session" && storedToken) return { ok: true, token: storedToken };
  return {
    ok: false,
    error:
      mode === "first-boot"
        ? "Pegá tu token de Supabase (sbp_…) para continuar."
        : "No hay token de Supabase guardado: pegá uno.",
  };
}

/** El proyecto sobre el que se opera: SIEMPRE el de este despliegue. El body no opina. */
export function provisionRef(envSupabaseUrl: string): string {
  return getRef(envSupabaseUrl);
}

/**
 * Funciones del bundle que faltan desplegar EN ESTA VERSIÓN, en el orden del bundle (DEPLOY_ORDER):
 * las que no están en vivo y las que están pero sin el hash de esta versión registrado.
 */
export function pendingFunctionSlugs(
  bundle: ReadonlyArray<{ slug: string; hash: string }>,
  deployedSlugs: ReadonlySet<string>,
  deployedHashes: Readonly<Record<string, string>>
): string[] {
  return bundle.filter((f) => !deployedSlugs.has(f.slug) || deployedHashes[f.slug] !== f.hash).map((f) => f.slug);
}

// ── Transición: el maestro SIN rol de un despliegue anterior ─────────────────────────────────
// Antes de la migración de roles (0078, que al empezar asigna `configuracion` a los usuarios que
// existían sin rol), el maestro viejo NO tiene rol. La web nueva lo trata como SIN_ACCESO, y las
// migraciones se aplican desde el panel: sin esta excepción quedaría afuera sin poder aplicar la
// que le devuelve el acceso. Por eso, SOLO mientras `_migrations` no tenga 0078, un usuario sin rol
// puede aplicar /api/provision/migrate (nada más) — y SOLO el maestro (el creado primero). Apenas 0078
// queda aplicada, la excepción se apaga sola. Alternativa manual: el UPDATE de CLAUDE.md.
export const ROLES_MIGRATION = "0078_agent_tools_scope.sql";

/**
 * El MAESTRO: el usuario creado primero (created_at, id). Es el único al que vale la excepción de
 * transición Y el único al que el backfill de 0078 le asigna `configuracion` (misma regla en SQL:
 * `order by created_at, id limit 1`). Cualquier otro usuario sin rol —p. ej. una cuenta de un
 * registro público abierto— queda sin acceso: sin esto, un atacante registrado llamaría
 * /api/provision/migrate con el token guardado y la 0078 lo promovería.
 */
export function masterUserId(users: ReadonlyArray<{ id: string; created_at: string }>): string | null {
  let best: { id: string; created_at: string } | null = null;
  for (const u of users) {
    const t = Date.parse(u.created_at);
    if (!Number.isFinite(t)) continue;
    if (best === null) {
      best = u;
      continue;
    }
    const bt = Date.parse(best.created_at);
    if (t < bt || (t === bt && u.id < best.id)) best = u;
  }
  return best ? best.id : null;
}

/**
 * `sinRol`: el usuario no tiene rol (ausente, null o ""). `rolesMigrationApplied` null = no se
 * pudo leer `_migrations` → cerrado. `esMaestro`: es el usuario creado primero.
 */
export function legacySinRolPermitido(
  sinRol: boolean,
  rolesMigrationApplied: boolean | null,
  esMaestro: boolean
): boolean {
  return sinRol && esMaestro && rolesMigrationApplied === false;
}
