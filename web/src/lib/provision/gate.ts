// lib/provision/gate.ts — quién puede usar /api/provision/{migrate,functions/deploy,updates}.
// Reglas (puras) en ./gate-logic.ts; esto hace el I/O: contar usuarios con la Admin API (cliente
// inline con la service-role del env) y, si ya hay alguno, exigir sesión con alcance configuracion.
//
// INVARIANT: this module MUST NOT import runtime-config.ts or service.ts. Usa el cliente de SESIÓN
// (anon key + cookies) y clientes inline con la service-role del env.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { authorizeScope } from "@/lib/auth/scope-guard";
import { listAllUsersBrief, listUsersHead } from "@/lib/provision/admin";
import { readProvisioned } from "@/lib/provision/provisioned";
import {
  legacySinRolPermitido,
  masterUserId,
  provisionNeedsSession,
  ROLES_MIGRATION,
  type ProvisionMode,
} from "@/lib/provision/gate-logic";

export type ProvisionGate =
  | { readonly ok: true; readonly mode: ProvisionMode }
  | { readonly ok: false; readonly response: NextResponse };

/** ¿Ya está aplicada la migración de roles (0078)? null = no se pudo leer. */
export async function rolesMigrationApplied(supabaseUrl: string, serviceRoleKey: string): Promise<boolean | null> {
  try {
    const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data, error } = await db.from("_migrations").select("filename").eq("filename", ROLES_MIGRATION).maybeSingle();
    if (error) return null;
    return data !== null;
  } catch {
    return null;
  }
}

/**
 * Sesión con alcance `configuracion`; o, con `legacySinRol`, un usuario SIN rol mientras la
 * migración de roles no esté aplicada (ver ROLES_MIGRATION en gate-logic.ts).
 */
export async function authorizeProvisionSession(
  supabaseUrl: string,
  serviceRoleKey: string,
  opts: { legacySinRol: boolean }
): Promise<ProvisionGate> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const decision = authorizeScope(user, "configuracion");
  if (decision.ok) return { ok: true, mode: "session" };
  if (opts.legacySinRol && decision.status === 403 && decision.sinRol === true && user) {
    // Solo el MAESTRO (el creado primero) y solo mientras la migración de roles no esté aplicada.
    const applied = await rolesMigrationApplied(supabaseUrl, serviceRoleKey);
    let esMaestro = false;
    if (applied === false) {
      try {
        esMaestro = masterUserId(await listAllUsersBrief(supabaseUrl, serviceRoleKey)) === user.id;
      } catch {
        esMaestro = false; // fail-closed
      }
    }
    if (legacySinRolPermitido(true, applied, esMaestro)) return { ok: true, mode: "session" };
  }
  return { ok: false, response: NextResponse.json({ ok: false, error: decision.error }, { status: decision.status }) };
}

export async function authorizeProvision(
  supabaseUrl: string,
  serviceRoleKey: string,
  opts: { legacySinRol: boolean } = { legacySinRol: false }
): Promise<ProvisionGate> {
  let userCount: number | null;
  try {
    userCount = (await listUsersHead(supabaseUrl, serviceRoleKey)).users.length;
  } catch {
    userCount = null; // fail-closed: provisionNeedsSession responde 503
  }
  // El marcador solo importa sin usuarios (con usuarios manda la sesión): no se lee de más.
  const provisioned = userCount === 0 ? await readProvisioned(supabaseUrl, serviceRoleKey) : false;
  const first = provisionNeedsSession(userCount, provisioned);
  if (first !== "check-session") {
    return first.ok
      ? { ok: true, mode: first.mode }
      : { ok: false, response: NextResponse.json({ ok: false, error: first.error }, { status: first.status }) };
  }
  return authorizeProvisionSession(supabaseUrl, serviceRoleKey, opts);
}
