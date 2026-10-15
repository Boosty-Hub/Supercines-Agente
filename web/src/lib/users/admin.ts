// lib/users/admin.ts — Supabase Auth Admin API para el módulo de Usuarios.
// SERVER-ONLY: usa el cliente de servicio (service-role, bypassa RLS). Solo desde rutas/páginas
// que validaron sesión + alcance `configuracion` (requireScope/requirePageScope): lo exige la
// guardia lib/config-access.test.ts, que ve este módulo como lib de servidor porque importa
// `@/lib/supabase/service`.
//
// Separado de lib/provision/admin.ts a propósito: aquel está atado al first-run (corre sin
// sesión y no puede importar el cliente de servicio).

import { createServiceClient } from "@/lib/supabase/service";
import { getScope, isScope, type Alcance, type Scope } from "@/lib/auth/roles";
import { appMetadataName } from "@/lib/auth/actor";

export type ManagedUser = {
  id: string;
  email: string;
  /** Nombre de app_metadata (solo service_role); nunca de user_metadata. */
  name: string | null;
  /** SIN_ACCESO si el usuario no tiene rol (no entra a nada hasta que se le asigne uno). */
  scope: Alcance;
  created_at: string;
  last_sign_in_at: string | null;
};

type RawUser = {
  id: string;
  email?: string;
  created_at: string;
  last_sign_in_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
};

// El alcance se resuelve con el MISMO `getScope` que usa el middleware: la tabla no puede mostrar
// un alcance distinto del que el gate aplica.
function toManaged(u: RawUser): ManagedUser {
  return {
    id: u.id,
    email: u.email ?? "",
    name: appMetadataName(u.app_metadata),
    scope: getScope(u),
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at ?? null,
  };
}

const PER_PAGE = 200;

/** TODOS los usuarios (pagina): el conteo de administradores no puede quedarse en la página 1. */
export async function listUsers(): Promise<ManagedUser[]> {
  const admin = createServiceClient().auth.admin;
  const out: ManagedUser[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(`listUsers: ${error.message}`);
    out.push(...data.users.map((u) => toManaged(u as RawUser)));
    if (data.users.length < PER_PAGE) return out;
  }
}

export async function createUser(email: string, password: string, scope: Scope): Promise<ManagedUser> {
  // El tipo ya lo exige; esto cubre a un llamador que lo saltee con un cast: nunca un alta sin rol.
  if (!isScope(scope)) throw new Error(`createUser: alcance inválido (${String(scope)})`);
  const { data, error } = await createServiceClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true, // el admin fija la contraseña; sin verificación por email
    // Se escribe el alcance LITERAL. La clave sigue llamándose `role` para no romper a los
    // usuarios que ya tienen "admin"/"editor" ahí: `getScope` lee los cinco valores.
    app_metadata: { role: scope },
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message ?? "sin usuario en la respuesta"}`);
  return toManaged(data.user as RawUser);
}

export async function updateUser(id: string, patch: { scope?: Scope; password?: string }): Promise<ManagedUser> {
  if (patch.scope !== undefined && !isScope(patch.scope)) {
    throw new Error(`updateUser: alcance inválido (${String(patch.scope)})`);
  }
  const attrs: { app_metadata?: { role: Scope }; password?: string } = {};
  if (patch.scope) attrs.app_metadata = { role: patch.scope };
  if (patch.password) attrs.password = patch.password;
  const { data, error } = await createServiceClient().auth.admin.updateUserById(id, attrs);
  if (error || !data.user) throw new Error(`updateUser: ${error?.message ?? "sin usuario en la respuesta"}`);
  return toManaged(data.user as RawUser);
}

export async function deleteUser(id: string): Promise<void> {
  const { error } = await createServiceClient().auth.admin.deleteUser(id);
  if (error) throw new Error(`deleteUser: ${error.message}`);
}

/**
 * Corta YA las sesiones del usuario: RPC `revoke_user_sessions(p_user_id)` (solo service_role;
 * borra auth.sessions y auth.refresh_tokens). Sin refresh token no puede renovar el access token;
 * el que ya tiene vale hasta su `exp` (jwt_expiry del proyecto).
 */
export async function revokeUserSessions(id: string): Promise<void> {
  const { error } = await createServiceClient().rpc("revoke_user_sessions", { p_user_id: id });
  if (!error) return;
  if (error.code === "PGRST202" || error.code === "42883") {
    throw new Error(
      "la función revoke_user_sessions no existe en la base: aplicá las migraciones pendientes (Ajustes → Actualizaciones)"
    );
  }
  throw new Error(`revoke_user_sessions: ${error.message}`);
}

/** Las dependencias reales de lib/users/mutations.ts. */
export const userDeps = { listUsers, updateUser, deleteUser, revokeSessions: revokeUserSessions };
