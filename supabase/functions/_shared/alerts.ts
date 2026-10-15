// _shared/alerts.ts
// ÚNICO punto de inserción en la tabla `alerts` desde las Edge Functions.
//
// · `kind` es `AlertKind` (unión derivada del registro _shared/alert-kinds.ts): un tipo no
//   registrado no compila. alert-kinds.test.ts rechaza cualquier `from("alerts").insert(…)`
//   fuera de este archivo, así que un tipo nuevo no puede saltarse el registro.
// · La fila lleva SOLO columnas del esquema base (0011): nunca las de entrega por webhook
//   (webhook_notified_at / webhook_posted_at / webhook_suppressed, 0076). Esas las escribe
//   únicamente claim_alerts_for_webhook. Por eso el insert funciona igual con o sin la
//   migración 0076 aplicada: desplegar las funciones antes que la migración no pierde alertas
//   (ver «Orden de deploy» en CLAUDE.md).
// · Nunca lanza: devuelve `{ error }` y el que llama decide (casi todos solo lo loguean; una
//   alerta que no se pudo guardar no debe tumbar el flujo que la detectó).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { ALERT_KINDS, aggregateWindowMinutes, type AlertKind } from "./alert-kinds.ts";

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertInsert = {
  kind: AlertKind;
  /** Si falta, la del registro (ALERT_KINDS[kind].severity). */
  severity?: AlertSeverity;
  title: string;
  description?: string | null;
  ref_table?: string | null;
  ref_id?: string | null;
  metadata?: Record<string, unknown>;
};

/** Columnas que escribe insertAlert: las del esquema base, nunca las del barrido (0076). */
export const ALERT_INSERT_COLUMNS = ["kind", "severity", "title", "description", "ref_table", "ref_id", "metadata"] as const;

/** Fila a insertar: solo las claves presentes de ALERT_INSERT_COLUMNS. */
export function alertRow(alert: AlertInsert): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  alert = { ...alert, severity: alert.severity ?? ALERT_KINDS[alert.kind].severity };
  for (const col of ALERT_INSERT_COLUMNS) {
    const v = alert[col];
    if (v !== undefined) row[col] = v;
  }
  return row;
}

export async function insertAlert(supabase: SupabaseClient, alert: AlertInsert): Promise<{ error: string | null }> {
  try {
    // Tipos de alta frecuencia y origen externo (webhook_rejected, webhook_unsigned,
    // inbound_dropped…): UNA fila por ventana con contador, en el INSERT mismo (RPC de 0076).
    const windowMin = aggregateWindowMinutes(alert.kind);
    if (windowMin !== undefined) {
      const row = alertRow(alert);
      const { error } = await supabase.rpc("insert_alert_aggregated", {
        p_kind: row.kind,
        p_severity: row.severity,
        p_title: row.title,
        p_description: row.description ?? null,
        p_ref_table: row.ref_table ?? null,
        p_metadata: row.metadata ?? {},
        p_window: `${windowMin} minutes`,
      });
      // Sin la migración 0076 (PGRST202: la función no existe) se inserta una fila normal: no se
      // pierde la alerta en la ventana entre desplegar las funciones y migrar.
      if (!error) return { error: null };
      if ((error as { code?: string }).code !== "PGRST202") return { error: error.message };
    }
    const { error } = await supabase.from("alerts").insert(alertRow(alert));
    return { error: error ? error.message : null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
