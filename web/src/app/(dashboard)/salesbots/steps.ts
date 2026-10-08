// Constantes compartidas del funnel de Salesbots. DEBEN reflejar exactamente
// el mismo orden que STEP_ORDER en
// supabase/functions/kommo-funnel-sync/index.ts — Deno no puede importar
// este archivo (runtimes separados), así que se mantienen en sync a mano.

export type FlowType = "cumpleanos" | "alquiler_salas";
export type Sede = "caracas" | "valencia" | "maracay";

export const SEDES: Sede[] = ["caracas", "valencia", "maracay"];

export const SEDE_LABELS: Record<Sede, string> = {
  caracas: "Caracas (Altos Mirandinos)",
  valencia: "Valencia",
  maracay: "Maracay",
};

export const FLOW_LABELS: Record<FlowType, string> = {
  cumpleanos: "Cumpleaños",
  alquiler_salas: "Alquiler de Salas",
};

export const STEP_LABELS: Record<FlowType, string[]> = {
  cumpleanos: [
    "Inició conversación",
    "Dio nombre/correo",
    "Eligió sede",
    "Eligió paquete",
    "Dio cantidad de niños",
    "Dio cantidad de adultos",
    "Dio fecha del evento",
  ],
  alquiler_salas: [
    "Inició conversación",
    "Dio nombre/correo",
    "Eligió sede",
    "Dio motivo del evento",
    "Dio cantidad de asistentes",
    "Dio horario del evento",
    "Eligió elementos a incluir",
  ],
};

/** Agregado liviano por sede+flujo para comparar sedes en el selector (punto 3). */
export type SedeFlowSummary = {
  sede: Sede;
  flow_type: FlowType;
  total: number;
  reached: number;
};

/** Agregado del período anterior de igual duración, misma sede (punto 2). */
export type PreviousPeriodSummary = Record<FlowType, { total: number; reached: number }>;

export type FunnelLeadRow = {
  kommo_lead_id: number;
  sede: Sede;
  flow_type: FlowType;
  contact_name: string | null;
  furthest_step_index: number;
  reached_human: boolean;
  kommo_created_at: string;
  kommo_updated_at: string | null;
};

// Umbral para considerar un lead estancado "frío": sin actividad en Kommo
// hace más de este tiempo. Proxy por tiempo, no una certeza de la causa real
// (no tenemos visibilidad de errores internos del salesbot) — pero es el
// único dato real y verificable que tenemos (kommo_updated_at).
export const COLD_STALL_HOURS = 48;

/** "hace 6 días" / "hace 3 horas" / "hace 40 min" — tiempo relativo en español. */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return "recién";
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `hace ${diffH}h`;
  const diffD = Math.round(diffH / 24);
  return `hace ${diffD} día${diffD === 1 ? "" : "s"}`;
}
