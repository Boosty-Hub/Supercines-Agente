// Identidad del actor para AUDITORÍA (línea de tiempo de etapas, quién movió un lead).
//
// NUNCA se toma de `user_metadata`: en Supabase Auth lo edita el propio usuario
// (`auth.updateUser({ data })`), así que un usuario del panel podría presentarse como
// otro. Las fuentes confiables son:
//   - el `id` (uid de auth: lo fija Supabase, no el usuario),
//   - `app_metadata` (solo la escribe service_role),
//   - el `email` (cambiarlo exige confirmación del nuevo correo).
// Por eso se guarda el id (actor_user_id) y el nombre a mostrar sale de acá.

import { truncateGraphemes } from "../text-safe.ts";

export type ActorUser = {
  id: string;
  email?: string | null;
  app_metadata?: Record<string, unknown> | null;
};

/** Nombre de app_metadata (full_name/name; solo lo escribe service_role), o null. */
export function appMetadataName(appMetadata: Record<string, unknown> | null | undefined): string | null {
  for (const k of ["full_name", "name"]) {
    const v = appMetadata?.[k];
    if (typeof v === "string" && v.trim()) return truncateGraphemes(v.trim(), 120);
  }
  return null;
}

/** Nombre a mostrar: app_metadata.full_name/name (solo service_role) → email → «usuario». */
export function trustedActorName(user: Pick<ActorUser, "email" | "app_metadata">): string {
  return appMetadataName(user.app_metadata) ?? (user.email?.trim() || "usuario");
}

/** Nombre a mostrar para un actor_user_id ya guardado: el usuario actual si existe; si no, la instantánea. */
export function displayActor(
  actorUserId: string | null | undefined,
  snapshot: string | null | undefined,
  byId: ReadonlyMap<string, string>,
): string | null {
  if (actorUserId && byId.has(actorUserId)) return byId.get(actorUserId)!;
  return snapshot ?? null;
}
