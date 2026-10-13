// Edge Function: kommo-funnel-sync
//
// Snapshot periódico (cron cada 15 min, ver 0058_salesbot_funnel.sql) del
// funnel de los 3 Salesbots nativos de Kommo (Cumpleaños / Alquiler de Salas,
// uno por sede: Caracas="Altos Mirandinos", Valencia, Maracay). El bot vive
// 100% dentro de Kommo — Muvito no interviene — y va llenando custom fields
// del lead sin mover nunca la etapa del pipeline.
//
// POR QUÉ UN SNAPSHOT Y NO EVENTOS. Desde 0061 el webhook `leads.update` /
// `leads.status` SÍ se procesa (process-inbound → syncLeadPositions), pero solo
// para sincronizar la etapa y el pipeline del lead (el tablero del inbox), y
// únicamente de los leads que ya tienen conversación con el agente. NO guarda
// los custom fields que va llenando el bot: ese avance (paso a paso, por lead
// del bot) sigue sin tener historial de eventos. Esta función lo lee directo de
// la API de Kommo y upsertea un snapshot en `salesbot_funnel_leads`. Los campos
// son acumulativos (nunca se revierten), así que el snapshot alcanza para
// reconstruir el funnel completo.
//
// UNA SOLA FUENTE DE VERDAD DE LA POSICIÓN. La lectura de cada sede ya trae el
// pipeline y la etapa de cada lead: se vuelcan también en `leads`
// (reconcile_funnel_lead_positions, 0062 → apply_positions_batch, 0061: el MISMO
// camino de escritura que el backfill, ordenado por kommo_position_at) en vez de
// pedirlos otra vez o de dejar que dos jobs mantengan la misma columna. Es una reconciliación: solo
// escribe lo que cambió y repara cualquier webhook de movimiento que se haya
// perdido. El recorrido completo de la cuenta (histórico) es de sync-pipelines.
//
// verify_jwt = false pero CON GATE: exige x-internal-secret (_shared/auth.ts);
// pg_cron lo manda desde trigger_kommo_funnel_sync() (0062).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { authorizeInternal } from "../_shared/auth.ts";
import { loadConfig } from "../_shared/config.ts";
import {
  fetchLeadsByPipelineSince,
  fetchContactsByIds,
  type KommoLeadRaw,
  type KommoCustomFieldValue,
} from "../_shared/kommo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// Sede = pipeline, 1:1 (confirmado contra la cuenta real de Kommo).
type Sede = "caracas" | "valencia" | "maracay";
const SEDE_PIPELINES: Record<Sede, number> = {
  caracas: 7847207, // Ventas Zona CCS
  valencia: 8028895, // Ventas Zona VAL
  maracay: 9647360, // Ventas Zona MRCAY
};

// field_id de los custom fields que el bot va llenando (verificados contra
// leads reales). "Evento de Interés" es el criterio de entrada al funnel:
// un lead sin este campo nunca entró al bot y no se guarda.
const FIELD = {
  evento: 2807533, // "Evento de Interés" → "Cumpleaños" | "Alquiler de Sala"
  sede: 2807535, // "Sede de interés"
  paquete: 2807537, // cumpleaños
  ninos: 2807539,
  adultos: 2807541,
  fecha: 2807543, // completion de cumpleaños
  motivo: 2807567, // alquiler
  asistentes: 2807569,
  horario: 2807571,
  elementos: 2807573, // completion de alquiler
} as const;

// Orden de pasos por flow_type. index 0/1/2 son compartidos (entrada, nombre
// /correo, sede); a partir de 3 cada flujo tiene su propio guion. El último
// índice de cada lista es la "completitud" = handoff a la asesora humana.
type StepKey = keyof typeof FIELD | "contacto";
const STEP_ORDER: Record<"cumpleanos" | "alquiler_salas", StepKey[]> = {
  cumpleanos: ["evento", "contacto", "sede", "paquete", "ninos", "adultos", "fecha"],
  alquiler_salas: ["evento", "contacto", "sede", "motivo", "asistentes", "horario", "elementos"],
};

// Ventana que se resincroniza en CADA corrida (no solo la vista del
// dashboard): da margen sobre el rango máximo que se puede pedir en la UI
// (30d) y tolera cualquier atraso del cron sin perder leads.
const RESYNC_WINDOW_DAYS = 35;

function extractField(values: KommoCustomFieldValue[] | null, fieldId: number): string | null {
  const f = (values ?? []).find((v) => v.field_id === fieldId);
  if (!f) return null;
  const joined = (f.values ?? [])
    .map((v) => String(v.value ?? "").trim())
    .filter(Boolean)
    .join(", ");
  return joined || null;
}

function classifyFlow(eventoValue: string): "cumpleanos" | "alquiler_salas" | null {
  const v = eventoValue.toLowerCase();
  if (v.includes("cumplea")) return "cumpleanos";
  if (v.includes("alquiler")) return "alquiler_salas";
  return null; // valor inesperado (ej: "Función Privada") → no es este funnel
}

// Vuelca pipeline + etapa de los leads leídos a `leads` (ver 0062). Por lotes
// para no mandar un JSON gigante; devuelve cuántos leads CAMBIARON.
const POSITIONS_BATCH = 500;
async function reconcilePositions(leads: KommoLeadRaw[], sede: Sede, readAtIso: string): Promise<number> {
  let changed = 0;
  for (let i = 0; i < leads.length; i += POSITIONS_BATCH) {
    const batch = leads.slice(i, i + POSITIONS_BATCH).map((l) => ({
      id: l.id,
      pipeline_id: l.pipeline_id,
      status_id: l.status_id,
    }));
    try {
      const { data, error } = await supabase.rpc("reconcile_funnel_lead_positions", {
        p_leads: batch,
        p_read_at: readAtIso,
      });
      if (error) throw new Error(error.message);
      changed += Number(data) || 0;
    } catch (err) {
      console.error(`kommo-funnel-sync posiciones (${sede}, lote ${i}):`, err instanceof Error ? err.message : String(err));
    }
  }
  return changed;
}

type SyncResult = { sede: Sede; processed: number; skipped: number; positions_updated: number };

async function syncSede(
  sede: Sede,
  sinceUnix: number,
  kommoDomain: string,
  kommoToken: string
): Promise<SyncResult> {
  const pipelineId = SEDE_PIPELINES[sede];
  // Instante en que se pidió la lectura: la posición que devuelve Kommo vale a esa
  // hora. apply_positions_batch (0061) no la aplica sobre un movimiento más nuevo
  // (webhook/agente/panel) que haya llegado mientras tanto.
  const readAtIso = new Date().toISOString();
  const leads: KommoLeadRaw[] = await fetchLeadsByPipelineSince(pipelineId, sinceUnix, kommoDomain, kommoToken);

  // La misma lectura trae el pipeline y la etapa de cada lead: se reconcilian en
  // `leads` (tablero del inbox) antes de filtrar por el bot. Fail-open: un fallo
  // acá nunca debe impedir el snapshot del funnel.
  const positionsUpdated = await reconcilePositions(leads, sede, readAtIso);

  // Solo nos interesan los que entraron al bot (Evento de Interés presente) y
  // el flow_type resuelve a uno conocido.
  type Candidate = { lead: KommoLeadRaw; flowType: "cumpleanos" | "alquiler_salas"; eventoValue: string };
  const candidates: Candidate[] = [];
  let skipped = 0;
  for (const lead of leads) {
    const eventoValue = extractField(lead.custom_fields_values, FIELD.evento);
    if (!eventoValue) { skipped++; continue; }
    const flowType = classifyFlow(eventoValue);
    if (!flowType) { skipped++; continue; }
    candidates.push({ lead, flowType, eventoValue });
  }

  if (candidates.length === 0) return { sede, processed: 0, skipped, positions_updated: positionsUpdated };

  // Batch de contactos (nombre + email) — una sola llamada por sede en vez de
  // N+1 por lead.
  const contactIds = candidates.map((c) => c.lead.contactId).filter((id): id is number => id != null);
  const contacts = await fetchContactsByIds(contactIds, kommoDomain, kommoToken);

  const rows = candidates.map(({ lead, flowType }) => {
    const contact = lead.contactId != null ? contacts.get(lead.contactId) : undefined;
    const steps: Record<StepKey, string | null> = {
      evento: extractField(lead.custom_fields_values, FIELD.evento),
      contacto: contact?.name || contact?.email ? "ok" : null,
      sede: extractField(lead.custom_fields_values, FIELD.sede),
      paquete: extractField(lead.custom_fields_values, FIELD.paquete),
      ninos: extractField(lead.custom_fields_values, FIELD.ninos),
      adultos: extractField(lead.custom_fields_values, FIELD.adultos),
      fecha: extractField(lead.custom_fields_values, FIELD.fecha),
      motivo: extractField(lead.custom_fields_values, FIELD.motivo),
      asistentes: extractField(lead.custom_fields_values, FIELD.asistentes),
      horario: extractField(lead.custom_fields_values, FIELD.horario),
      elementos: extractField(lead.custom_fields_values, FIELD.elementos),
    };

    const order = STEP_ORDER[flowType];
    let furthest = 0;
    for (let i = 0; i < order.length; i++) {
      if (steps[order[i]]) furthest = i; // tolerante a huecos: toma el MÁXIMO no-vacío
    }
    const reachedHuman = furthest === order.length - 1;

    return {
      kommo_lead_id: lead.id,
      kommo_contact_id: lead.contactId,
      sede,
      flow_type: flowType,
      status_id: lead.status_id,
      responsible_user_id: lead.responsible_user_id,
      contact_name: contact?.name ?? null,
      contact_email: contact?.email ?? null,
      step_sede: steps.sede,
      step_paquete: steps.paquete,
      step_ninos: steps.ninos,
      step_adultos: steps.adultos,
      step_motivo: steps.motivo,
      step_asistentes: steps.asistentes,
      step_horario: steps.horario,
      step_elementos: steps.elementos,
      step_fecha: steps.fecha,
      furthest_step_index: furthest,
      reached_human: reachedHuman,
      kommo_created_at: new Date(lead.created_at * 1000).toISOString(),
      kommo_updated_at: lead.updated_at ? new Date(lead.updated_at * 1000).toISOString() : null,
      last_synced_at: new Date().toISOString(),
    };
  });

  // Upsert por lotes (fail-open por lote: un lote malo no tira el resto).
  const UPSERT_BATCH = 200;
  let processed = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    try {
      const { error } = await supabase
        .from("salesbot_funnel_leads")
        .upsert(batch, { onConflict: "kommo_lead_id" });
      if (error) throw new Error(error.message);
      processed += batch.length;
    } catch (err) {
      console.error(`kommo-funnel-sync upsert (${sede}, lote ${i}):`, err instanceof Error ? err.message : String(err));
    }
  }

  return { sede, processed, skipped, positions_updated: positionsUpdated };
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("kommo-funnel-sync OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  // Gate: verify_jwt = false (el cron no manda JWT de usuario), así que la
  // autorización es el secreto interno de bajo privilegio (ver 0062).
  const denied = await authorizeInternal(req, supabase);
  if (denied) return denied;

  try {
    const runtimeCfg = await loadConfig(supabase);
    const kommoDomain = runtimeCfg.require("KOMMO_API_DOMAIN");
    const kommoToken = runtimeCfg.require("KOMMO_ACCESS_TOKEN");

    const sinceUnix = Math.floor(Date.now() / 1000) - RESYNC_WINDOW_DAYS * 24 * 3600;
    const sedes: Sede[] = ["caracas", "valencia", "maracay"];

    const results: SyncResult[] = [];
    for (const sede of sedes) {
      try {
        results.push(await syncSede(sede, sinceUnix, kommoDomain, kommoToken));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`kommo-funnel-sync (${sede}):`, msg);
        results.push({ sede, processed: 0, skipped: 0, positions_updated: 0 });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, by_sede: results }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("kommo-funnel-sync:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
