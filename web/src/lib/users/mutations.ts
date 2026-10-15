// Reglas de /api/users (crear, cambiar alcance/contraseña, borrar), PURAS y con el I/O inyectado:
// así se prueban sin Supabase (lib/users-mutations.test.ts) y las rutas solo cablean
// `lib/users/admin.ts`.
//
// Lo que se decide acá:
//   - Todo alta y todo cambio de alcance llevan un alcance EXPLÍCITO y válido. «Sin rol» es
//     SIN_ACCESO (lib/auth/roles.ts): crear sin alcance no es «crear un admin».
//   - Nadie se baja el alcance ni se borra a sí mismo, y no se puede dejar el panel sin ningún
//     `configuracion` (la única salida sería la Admin API con la service-role).
//   - Bajar el alcance o borrar REVOCA las sesiones del usuario (RPC revoke_user_sessions):
//     un access token ya emitido sigue valiendo con el alcance viejo hasta expirar
//     (`jwt_expiry`, 3600 s por default) y el refresh token permitía seguir renovándolo.

import { esBajaDeAlcance, isScope, type Alcance, type Scope } from "../auth/roles.ts";

export type UserRow = { id: string; scope: Alcance };

export type UserDeps<U extends UserRow> = {
  listUsers(): Promise<U[]>;
  updateUser(id: string, patch: { scope?: Scope; password?: string }): Promise<U>;
  deleteUser(id: string): Promise<void>;
  /** Borra las sesiones y refresh tokens del usuario. Lanza si no pudo (p. ej. RPC inexistente). */
  revokeSessions(id: string): Promise<void>;
};

export type Fail = { readonly ok: false; readonly status: number; readonly error: string };

export const SCOPE_INVALIDO = "scope debe ser 'operacion', 'contenido' o 'configuracion'";
export const MIN_PASSWORD = 8;

/** Alcance pedido por la API. `role` y los alias heredados (admin/editor) se aceptan para leer. */
export function parseScopeInput(v: unknown): Scope | null {
  if (isScope(v)) return v;
  if (v === "admin") return "configuracion";
  if (v === "editor") return "contenido";
  return null;
}

/** Alta: el alcance es OBLIGATORIO (sin él, 400). */
export function validateCreate(body: {
  email?: unknown;
  password?: unknown;
  scope?: unknown;
  role?: unknown;
}): { ok: true; email: string; password: string; scope: Scope } | Fail {
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const scope = parseScopeInput(body.scope ?? body.role);
  if (!scope) return { ok: false, status: 400, error: `Falta el alcance: ${SCOPE_INVALIDO}` };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, status: 400, error: "Email inválido" };
  if (password.length < MIN_PASSWORD)
    return { ok: false, status: 400, error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres` };
  return { ok: true, email, password, scope };
}

export function validatePatch(body: {
  scope?: unknown;
  role?: unknown;
  password?: unknown;
}): { ok: true; patch: { scope?: Scope; password?: string } } | Fail {
  const patch: { scope?: Scope; password?: string } = {};
  const pedido = body.scope ?? body.role;
  if (pedido !== undefined) {
    const scope = parseScopeInput(pedido);
    if (!scope) return { ok: false, status: 400, error: SCOPE_INVALIDO };
    patch.scope = scope;
  }
  if (body.password !== undefined) {
    const pw = String(body.password);
    if (pw.length < MIN_PASSWORD)
      return { ok: false, status: 400, error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres` };
    patch.password = pw;
  }
  if (patch.scope === undefined && patch.password === undefined)
    return { ok: false, status: 400, error: "Nada que actualizar" };
  return { ok: true, patch };
}

function quitaUltimoAdmin(users: UserRow[], target: UserRow | undefined): boolean {
  const admins = users.filter((u) => u.scope === "configuracion").length;
  return target?.scope === "configuracion" && admins <= 1;
}

function revokeFailed(accion: string, e: unknown): Fail {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    ok: false,
    status: 500,
    error:
      `${accion}, pero NO se pudieron revocar sus sesiones: ${msg}. ` +
      "Hasta que expire su token (jwt_expiry, 3600 s por default) puede seguir entrando con la sesión anterior.",
  };
}

/** PATCH /api/users/[id]. */
export async function applyUserUpdate<U extends UserRow>(
  deps: UserDeps<U>,
  input: { actorId: string; targetId: string; patch: { scope?: Scope; password?: string } }
): Promise<{ ok: true; user: U; revoked: boolean } | Fail> {
  const { actorId, targetId, patch } = input;
  let baja = false;
  if (patch.scope !== undefined) {
    const users = await deps.listUsers();
    const target = users.find((u) => u.id === targetId);
    if (!target) return { ok: false, status: 404, error: "Usuario inexistente" };
    baja = esBajaDeAlcance(target.scope, patch.scope);
    if (baja) {
      // No auto-degradarse: quien se baja el alcance pierde esta pantalla y no puede deshacerlo.
      if (actorId === targetId) return { ok: false, status: 400, error: "No podés bajarte el alcance a vos mismo" };
      if (quitaUltimoAdmin(users, target))
        return { ok: false, status: 400, error: "No podés degradar al último administrador" };
    }
  }
  const user = await deps.updateUser(targetId, patch);
  // Bajar el alcance Y cambiar la contraseña cortan las sesiones: el cambio de contraseña de la
  // Admin API NO invalida los refresh tokens existentes, así que quien tenía la contraseña vieja
  // (o un token robado) seguiría renovando su sesión.
  const cambioContrasena = patch.password !== undefined;
  if (!baja && !cambioContrasena) return { ok: true, user, revoked: false };
  // Después del cambio: lo que el usuario renueve desde acá ya sale con el alcance/clave nuevos, y
  // lo vigente se corta ahora.
  try {
    await deps.revokeSessions(targetId);
  } catch (e) {
    return revokeFailed(baja ? "El alcance se cambió" : "La contraseña se cambió", e);
  }
  return { ok: true, user, revoked: true };
}

/** DELETE /api/users/[id]. */
export async function applyUserDelete<U extends UserRow>(
  deps: UserDeps<U>,
  input: { actorId: string; targetId: string }
): Promise<{ ok: true } | Fail> {
  const { actorId, targetId } = input;
  if (actorId === targetId) return { ok: false, status: 400, error: "No podés borrarte a vos mismo" };
  const users = await deps.listUsers();
  const target = users.find((u) => u.id === targetId);
  if (!target) return { ok: false, status: 404, error: "Usuario inexistente" };
  if (quitaUltimoAdmin(users, target)) return { ok: false, status: 400, error: "No podés borrar al último administrador" };
  // Primero se revoca (con el usuario todavía existente) y después se borra. Si revocar falla, se
  // borra igual —borrar al usuario también le corta la renovación— y se informa el error.
  let revokeError: unknown = null;
  try {
    await deps.revokeSessions(targetId);
  } catch (e) {
    revokeError = e;
  }
  await deps.deleteUser(targetId);
  if (revokeError !== null) return revokeFailed("El usuario se borró", revokeError);
  return { ok: true };
}
