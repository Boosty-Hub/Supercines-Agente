// _shared/health-incidentes.ts
//
// Reporte y cierre de INCIDENTES DE SISTEMA — las fallas de plataforma que
// dejan al agente mudo sin que nada en el dashboard lo delate (ver
// migración 0062_system_incidents.sql para el porqué de la tabla).
//
// Solo el barrido periódico de `health-scan` abre y cierra estos incidentes.
// Es DB I/O puro (necesita un SupabaseClient real), así que —igual que
// `_shared/config.ts` y `_shared/alerts-human-review.ts`— no tiene test
// propio; la lógica de DECISIÓN que alimenta a `reportIncident` vive aparte,
// en `_shared/health-detectores.ts`, que sí es pura y sí se prueba.
//
// Todo es fail-open: si el reporte del incidente falla, se loguea y sigue. Un
// problema al anotar la falla nunca puede convertirse en una segunda falla.

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type IncidentKind =
  | "kommo_webhook_caido"
  | "kommo_token"
  | "ingesta_detenida"
  | "cola_atascada";

export type IncidentInput = {
  kind: IncidentKind;
  severity?: "warning" | "critical";
  title: string;
  description?: string;
  /** Qué tiene que hacer un humano para arreglarlo. Se muestra en la franja. */
  remedy?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Abre el incidente si no existe; si ya está abierto, refresca `last_seen_at`.
 *
 * El índice único parcial `system_incidents_kind_abierto_idx` garantiza que no
 * haya dos abiertos del mismo kind, así que esto se puede llamar en cada
 * barrido sin inflar la tabla. Se hace update-primero para no gastar un
 * insert que va a chocar en el caso común (incidente ya abierto).
 */
export async function reportIncident(
  supabase: SupabaseClient,
  inc: IncidentInput,
): Promise<void> {
  try {
    const ahora = new Date().toISOString();

    const { data: abierto } = await (supabase as any)
      .from("system_incidents")
      .select("id")
      .eq("kind", inc.kind)
      .is("resolved_at", null)
      .maybeSingle();

    if (abierto?.id) {
      await (supabase as any)
        .from("system_incidents")
        .update({
          last_seen_at: ahora,
          // El detalle puede cambiar entre detecciones (otro contador, otro
          // status HTTP); el incidente sigue siendo el mismo.
          description: inc.description ?? null,
          metadata: inc.metadata ?? {},
        })
        .eq("id", abierto.id);
      return;
    }

    const { error } = await (supabase as any).from("system_incidents").insert({
      kind: inc.kind,
      severity: inc.severity ?? "critical",
      title: inc.title,
      description: inc.description ?? null,
      remedy: inc.remedy ?? null,
      metadata: inc.metadata ?? {},
      detected_at: ahora,
      last_seen_at: ahora,
    });
    // 23505 = unique_violation: otra invocación concurrente lo abrió primero.
    // Es el resultado esperado bajo carga, no un error.
    if (error && (error as any).code !== "23505") {
      console.warn("reportIncident insert:", error.message);
    }
  } catch (e) {
    console.warn("reportIncident:", e instanceof Error ? e.message : String(e));
  }
}

/** Cierra el incidente abierto de ese kind, si lo hay. No falla si no existe. */
export async function resolveIncident(
  supabase: SupabaseClient,
  kind: IncidentKind,
): Promise<void> {
  try {
    await (supabase as any)
      .from("system_incidents")
      .update({ resolved_at: new Date().toISOString() })
      .eq("kind", kind)
      .is("resolved_at", null);
  } catch (e) {
    console.warn("resolveIncident:", e instanceof Error ? e.message : String(e));
  }
}
