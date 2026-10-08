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

export type FunnelLeadRow = {
  kommo_lead_id: number;
  sede: Sede;
  flow_type: FlowType;
  contact_name: string | null;
  furthest_step_index: number;
  reached_human: boolean;
  kommo_created_at: string;
};
