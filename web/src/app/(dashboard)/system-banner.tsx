import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SystemBannerClient, type Incidente } from "./system-banner-client";

/**
 * Franja de incidentes de plataforma. Va ARRIBA DE TODO, fuera del `<main>`
 * scrolleable: un apagón del agente no puede quedar fuera de vista por haber
 * scrolleado la página. Se monta en modo normal y en modo embed.
 *
 * Muestra solo lo que deja al agente MUDO — webhook caído, token inválido,
 * ingesta detenida, cola atascada (ver migración 0062_system_incidents.sql).
 * No compite con `alerts` (drafts fallidos, mensajes que piden revisión), que
 * es una bandeja de trabajo y vive en la Torre de Control (panel lateral,
 * `torre-de-control.tsx`) — no tiene página propia.
 *
 * Si no hay incidentes abiertos no renderiza nada: cero ruido cuando el
 * sistema está sano. Un banner que está siempre presente deja de leerse.
 *
 * `puedeActuar` separa VER de ACTUAR. La franja la ve todo el mundo —quien
 * está contestando conversaciones tiene que enterarse de que el agente está
 * mudo—, pero reconectar el webhook, omitir la cola atascada o silenciar la
 * franja son acciones de recuperación de plataforma y exigen alcance
 * `configuracion`, que es lo que el middleware hace cumplir en
 * `/api/incidents` y `/api/kommo` (ver `PATH_SCOPES` en `lib/auth/roles.ts`).
 * Sin esto la franja mostraría botones que devuelven 403, y un botón que
 * falla es peor que ninguno.
 */
export default async function SystemBanner({ puedeActuar = false }: { puedeActuar?: boolean }) {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("system_incidents")
    .select("id, kind, severity, title, description, remedy, detected_at, muted_until")
    .is("resolved_at", null)
    .order("severity", { ascending: true }) // 'critical' < 'warning' alfabéticamente
    .order("detected_at", { ascending: true });

  // La tabla puede no existir todavía (clon sin migrar). Que falte el sistema
  // de incidentes no puede tumbar el dashboard entero.
  if (error) return null;

  const ahora = Date.now();
  const visibles = (data ?? []).filter(
    (i) => !i.muted_until || new Date(i.muted_until).getTime() < ahora,
  ) as Incidente[];

  if (visibles.length === 0) return null;

  return <SystemBannerClient incidentes={visibles} puedeActuar={puedeActuar} />;
}
