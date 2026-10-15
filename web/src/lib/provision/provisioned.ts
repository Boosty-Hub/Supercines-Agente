// lib/provision/provisioned.ts — marcador PERSISTENTE «esta instalación ya fue provisionada».
//
// INVARIANT: no importa runtime-config.ts ni service.ts: clientes inline con la service-role del env
// (se usa en /api/provision, que corre antes de que exista nada).
//
// POR QUÉ: «primer arranque» NO puede decidirse contando usuarios. Si alguien borra todos los
// usuarios (o quedan 0 por un error) de una instalación ya provisionada, el modo «sin usuarios»
// reabriría el provisioner sin sesión (y el register permitiría crear un maestro nuevo). Un
// marcador escrito por el register (y, para instalaciones existentes, por la migración 0083 si ya
// había usuarios) vive en `_app_secrets` (solo service_role) y NO desaparece al borrar usuarios.
//
// El register lo RECLAMA de forma atómica ANTES de crear al maestro (insert con clave única): dos
// registros concurrentes en un despliegue recién creado no pueden crear dos maestros.

import { createClient } from "@supabase/supabase-js";

export const PROVISIONED_KEY = "PROVISIONED_AT";

/** Códigos de PostgREST/Postgres que significan «la tabla todavía no existe» (migraciones sin aplicar). */
export function isMissingTableError(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205" || code === "PGRST106";
}

/** Violación de unicidad: el marcador ya existe. */
export function isUniqueViolation(code: string | undefined): boolean {
  return code === "23505";
}

function client(supabaseUrl: string, serviceRoleKey: string) {
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
}

/**
 * ¿Está marcada como provisionada? true/false; null = NO se pudo saber (error que no es «falta la
 * tabla»): quien decide debe cerrar. Sin tabla `_app_secrets` (migraciones sin aplicar) = false:
 * todavía no hay nada provisionado.
 */
export async function readProvisioned(supabaseUrl: string, serviceRoleKey: string): Promise<boolean | null> {
  try {
    const { data, error } = await client(supabaseUrl, serviceRoleKey)
      .from("_app_secrets")
      .select("clave")
      .eq("clave", PROVISIONED_KEY)
      .maybeSingle();
    if (error) return isMissingTableError(error.code) ? false : null;
    return data !== null;
  } catch {
    return null;
  }
}

export type ClaimResult = { ok: true } | { ok: false; reason: "already" | "no-table" | "error"; error?: string };

/** Reclama el marcador (atómico: clave primaria). already = otro register ya lo tomó o la instalación está provisionada. */
export async function claimProvisioned(supabaseUrl: string, serviceRoleKey: string): Promise<ClaimResult> {
  try {
    const { error } = await client(supabaseUrl, serviceRoleKey)
      .from("_app_secrets")
      .insert({ clave: PROVISIONED_KEY, valor: new Date().toISOString() });
    if (!error) return { ok: true };
    if (isUniqueViolation(error.code)) return { ok: false, reason: "already" };
    if (isMissingTableError(error.code)) return { ok: false, reason: "no-table", error: error.message };
    return { ok: false, reason: "error", error: error.message };
  } catch (e) {
    return { ok: false, reason: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Libera el marcador (solo si la creación del maestro falló después de reclamarlo). */
export async function releaseProvisioned(supabaseUrl: string, serviceRoleKey: string): Promise<void> {
  try {
    await client(supabaseUrl, serviceRoleKey).from("_app_secrets").delete().eq("clave", PROVISIONED_KEY);
  } catch {
    /* mejor esfuerzo: si no se pudo liberar, el operador lo borra a mano (README) */
  }
}
