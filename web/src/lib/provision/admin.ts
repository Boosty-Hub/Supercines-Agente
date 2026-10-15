// lib/provision/admin.ts
// Supabase Auth Admin API helpers.
//
// These functions use plain fetch with the service-role key (passed as Bearer
// token to the Auth Admin endpoint). They MUST NOT import runtime-config.ts
// or service.ts — they build clients inline from caller-supplied credentials
// or process.env, so they are safe to use before the DB schema exists.

// ─── LIST USERS (head / count check) ─────────────────────────────────────────

export interface AdminUsersPage {
  users: Array<{
    id: string;
    email?: string;
    created_at: string;
  }>;
  aud: string;
}

/**
 * Fetch the first page of admin users (page=1, per_page=1).
 * Used as a cheap "does at least one user exist?" check.
 */
export async function listUsersHead(
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<AdminUsersPage> {
  const res = await fetch(
    `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`,
    {
      cache: "no-store",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Admin listUsers failed (${res.status}): ${text}`
    );
  }

  return res.json() as Promise<AdminUsersPage>;
}

/**
 * Todos los usuarios (id + created_at), paginando la Admin API de a 200. Sirve para hallar al
 * MAESTRO (el creado primero) en la excepción de transición del provisioner.
 */
export async function listAllUsersBrief(
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<Array<{ id: string; created_at: string }>> {
  const out: Array<{ id: string; created_at: string }> = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=200`, {
      cache: "no-store",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    if (!res.ok) throw new Error(`Admin listUsers failed (${res.status})`);
    const data = (await res.json()) as AdminUsersPage;
    for (const u of data.users ?? []) out.push({ id: u.id, created_at: u.created_at });
    if ((data.users ?? []).length < 200) break;
  }
  return out;
}

// ─── CREATE USER ─────────────────────────────────────────────────────────────

export interface CreatedUser {
  id: string;
  email: string;
  created_at: string;
}

/**
 * Create THE MASTER user via the Auth Admin API (first-run only).
 * Uses email_confirm: true so the user can log in immediately.
 *
 * INVARIANT: email_confirm must always be true (no email confirmation flow
 * in single-tenant first-run setup).
 * INVARIANT: el maestro nace con `app_metadata.role = "configuracion"` EXPLÍCITO. Un usuario sin
 * rol no tiene acceso a nada (lib/auth/roles.ts), así que el maestro no puede depender de eso.
 */
export const MASTER_ROLE = "configuracion";

export async function createMasterUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
  password: string
): Promise<CreatedUser> {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true, // INVARIANT: always true
      app_metadata: { role: MASTER_ROLE }, // INVARIANT: rol explícito
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Admin createUser failed (${res.status}): ${text}`
    );
  }

  return res.json() as Promise<CreatedUser>;
}
