// lib/users/admin.ts — Supabase Auth Admin API para el módulo de Usuarios.
// SERVER-ONLY: usa la service-role key (bypassa RLS). Nunca importar desde el
// cliente ni desde rutas sin gate de admin.
//
// Separado de lib/provision/admin.ts a propósito: aquel está atado al first-run
// (crea el master sin auth) y su createUser no maneja roles.
// server-only: usa la service-role key; no importar desde el cliente.

import type { Role } from "@/lib/auth/roles";

function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  return { url, key };
}

function headers(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

export type ManagedUser = {
  id: string;
  email: string;
  role: Role;
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

function toManaged(u: RawUser): ManagedUser {
  const role: Role = u.app_metadata?.role === "editor" ? "editor" : "admin";
  return {
    id: u.id,
    email: u.email ?? "",
    role,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at ?? null,
  };
}

export async function listUsers(): Promise<ManagedUser[]> {
  const { url, key } = env();
  const res = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=200`, {
    cache: "no-store",
    headers: headers(key),
  });
  if (!res.ok) throw new Error(`listUsers (${res.status}): ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { users?: RawUser[] };
  return (data.users ?? []).map(toManaged);
}

export async function countAdmins(): Promise<number> {
  return (await listUsers()).filter((u) => u.role === "admin").length;
}

export async function createUser(email: string, password: string, role: Role): Promise<ManagedUser> {
  const { url, key } = env();
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({
      email,
      password,
      email_confirm: true, // el admin fija la contraseña; sin verificación por email
      app_metadata: { role },
    }),
  });
  if (!res.ok) throw new Error(`createUser (${res.status}): ${await res.text().catch(() => "")}`);
  return toManaged((await res.json()) as RawUser);
}

export async function updateUser(
  id: string,
  patch: { role?: Role; password?: string }
): Promise<ManagedUser> {
  const { url, key } = env();
  const body: Record<string, unknown> = {};
  if (patch.role) body.app_metadata = { role: patch.role };
  if (patch.password) body.password = patch.password;
  const res = await fetch(`${url}/auth/v1/admin/users/${id}`, {
    method: "PUT",
    headers: headers(key),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`updateUser (${res.status}): ${await res.text().catch(() => "")}`);
  return toManaged((await res.json()) as RawUser);
}

export async function deleteUser(id: string): Promise<void> {
  const { url, key } = env();
  const res = await fetch(`${url}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: headers(key),
  });
  if (!res.ok) throw new Error(`deleteUser (${res.status}): ${await res.text().catch(() => "")}`);
}
