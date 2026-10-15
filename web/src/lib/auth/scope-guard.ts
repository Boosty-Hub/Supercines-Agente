// Decisión pura de «¿esta sesión alcanza para esto?», compartida por las rutas de API
// (require-scope.ts → 401/403) y por las páginas de servidor (→ redirect). Sin imports de
// servidor: la prueban los tests de node.
//
// El middleware ya hace cumplir PATH_SCOPES por prefijo; esto es la SEGUNDA comprobación que
// hace cada ruta/página sensible por su cuenta, y la que fabrica el `ConfigWriter` que exige
// setConfigValues: sin pasar por acá no hay con qué escribir runtime_config.

import { esSinRol, getScope, SIN_ACCESO, scopeAlcanza, type Scope } from "./roles.ts";

type UserLike = { email?: string | null; app_metadata?: Record<string, unknown> | null } | null | undefined;

export type ScopeDecision =
  | { readonly ok: true; readonly scope: Scope }
  | { readonly ok: false; readonly status: 401 | 403; readonly error: string; readonly sinAcceso?: true; readonly sinRol?: true };

export function authorizeScope(user: UserLike, required: Scope): ScopeDecision {
  if (!user) return { ok: false, status: 401, error: "unauthorized" };
  const alcance = getScope(user);
  // Sin rol = sin acceso a nada (roles.ts): 403 aunque la ruta pida el alcance más bajo.
  if (alcance === SIN_ACCESO) {
    return {
      ok: false,
      status: 403,
      error: "Usuario sin alcance asignado",
      sinAcceso: true,
      // Solo el que NO tiene rol (el maestro anterior a este módulo) puede entrar por la excepción de
      // transición del provisioner; un rol presente pero irreconocible no.
      ...(esSinRol(user) ? { sinRol: true as const } : {}),
    };
  }
  if (!scopeAlcanza(alcance, required)) {
    return { ok: false, status: 403, error: `Requiere alcance ${required}` };
  }
  return { ok: true, scope: alcance };
}

/** Quién escribe runtime_config y con qué alcance (lo valida setConfigValues clave por clave). */
export type ConfigWriter = { readonly by: string; readonly scope: Scope };

export function configWriterFor(user: UserLike, scope: Scope, fallback = "dashboard"): ConfigWriter {
  return { by: user?.email || fallback, scope };
}
