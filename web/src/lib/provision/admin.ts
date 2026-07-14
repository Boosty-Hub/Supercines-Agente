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

// ─── CREATE USER ─────────────────────────────────────────────────────────────

export interface CreatedUser {
  id: string;
  email: string;
  created_at: string;
}

/**
 * Create a new user via the Auth Admin API.
 * Uses email_confirm: true so the user can log in immediately.
 *
 * INVARIANT: email_confirm must always be true (no email confirmation flow
 * in single-tenant first-run setup).
 */
export async function createUser(
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
