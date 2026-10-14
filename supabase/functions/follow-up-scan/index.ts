// Edge Function: follow-up-scan
//
// Evalúa leads elegibles para seguimiento automático de WhatsApp y, por cada uno,
// abre una sesión CMA (Managed Agent) en "modo seguimiento" para decidir si
// enviar la siguiente plantilla, saltear o detener la secuencia.
//
// Flujo:
//   POST → carga config → llama follow_up_due_leads RPC (SQL gate)
//         → si 0 leads: 200 {processed:0}
//         → si hay leads: 202 inmediato + EdgeRuntime.waitUntil(loop secuencial)
//
// Invariantes:
//   - GET → healthcheck 200
//   - verify_jwt = false (ver supabase/config.toml)
//   - La config se resuelve ANTES del waitUntil boundary (igual que generate-response)
//   - Un error en un lead nunca mata el sweep; se loguea y continúa
//
// IDEMPOTENCIA DEL ENVÍO (0072, decisiones en _shared/followup-claim.ts):
//   - Cada lead se RESERVA por (lead, paso) con claim_follow_up antes de gastar la
//     sesión del agente: dos barridos superpuestos (uno largo dura más que los 5 min
//     del cron) o el reintento manual del panel contra el barrido → gana UNO; el otro
//     no envía. La reserva es la fila del intento en follow_ups (`claimed`, dueño =
//     runId de la invocación, lease de 10 min).
//   - Antes del salesbot se fija la marca write-ahead (mark_follow_up_sending, con la
//     foto de salientes del lead). Sin la marca no se dispara nada.
//   - El cierre (finish_follow_up) registra `sent` y avanza el lead en UNA transacción;
//     un índice único impide registrar dos veces el mismo paso.
//   - Worker muerto: sin la marca → intento `failed` interrumpido y se reintenta (tope
//     de 3 por paso); con la marca → NUNCA se reenvía: se verifica en Kommo si salió
//     (→ `sent`) o queda «sin confirmar» + alerta, y solo una persona lo reenvía.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { authorizeInternal } from "../_shared/auth.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.95.1";
import { loadConfig } from "../_shared/config.ts";
import {
  runSalesbot,
  fetchLeadStage,
  fetchOutgoingEventIds,
  fetchOutgoingEvents,
  KOMMO_WON_STATUS,
  KOMMO_LOST_STATUS,
} from "../_shared/kommo.ts";
import { captureSessionUsage } from "../_shared/usage.ts";
import { createAnthropicClient } from "../_shared/anthropic-client.ts";
import { isBusinessHours, type BusinessHoursConfig, DEFAULT_TIMEZONE } from "../_shared/business-hours.ts";
import {
  evaluateRetryGate,
  parseScanRequest,
  retryOutcomeFor,
  type RetryOutcome,
  type ScanRequest,
} from "../_shared/followup-retry.ts";
import {
  closeFor,
  FOLLOW_UP_LEASE_SECONDS,
  FollowUpLeaseLostError,
  interpretClaim,
  resolveDeadFollowUp,
  runClaimedFollowUp,
  type ClaimClose,
  type FollowUpOutcome,
  type LeadRunResult,
  type SendingMark,
} from "../_shared/followup-claim.ts";
import { isSystemHalted, haltedResponse, logHalted } from "../_shared/halt.ts";
import { modelFor } from "../_shared/models.ts";
import { getBudgetGate } from "../_shared/budget.ts";
import { leadsStoreInstructions, MASTER_STORE_INSTRUCTIONS } from "../_shared/memory-instructions.ts";
import { fetchLeadHistory } from "../_shared/history.ts";
import { OutboundBlockedError, outboundLeak, writeClientText } from "../_shared/outbound.ts";
import { UNTRUSTED_NOTICE } from "../_shared/untrusted.ts";
import { keepAlive } from "../_shared/keep-alive.ts";
import { resolveTemplateVariables } from "../_shared/followup-variables.ts";
import { insertAlert } from "../_shared/alerts.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// Fecha/hora actual en la zona horaria del operador, en español.
function formatNow(timezone: string): string {
  const now = new Date();
  try {
    return new Intl.DateTimeFormat("es", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
  } catch {
    return now.toISOString();
  }
}

// ---- Tipos ----

type DueLeadRow = {
  lead_id: string;
  step_number: number;
  delay_hours: number;
  template_id: string | null;
};

type TemplateVariable = {
  name: string;
  description: string;
  // Shape nuevo: la variable apunta DIRECTO al campo custom de Kommo.
  kommo_field_id?: number | null;
  kommo_field_name?: string | null;
  // Shape legacy: id en la tabla follow_up_fields (se resuelve por compat).
  field_id?: string | null;
};

type FollowUpTemplate = {
  id: string;
  name: string;
  body: string;
  variables: TemplateVariable[];
  salesbot_id: number | null;
  enabled: boolean;
};

// Resuelve el id del campo de Kommo de una variable: directo (kommo_field_id) o
// vía la tabla legacy follow_up_fields (field_id). Devuelve null si no hay forma.
async function resolveKommoFieldId(variable: TemplateVariable): Promise<number | null> {
  if (typeof variable.kommo_field_id === "number") return variable.kommo_field_id;
  if (variable.field_id) {
    const field = await getField(variable.field_id);
    return field?.kommo_field_id ?? null;
  }
  return null;
}

type FollowUpField = {
  id: string;
  kommo_field_id: number;
};

type LeadRow = {
  id: string;
  kommo_lead_id: number;
  display_name: string | null;
  // Cache local de la etapa. Se compara contra la etapa EN VIVO para decidir si
  // hay que re-sincronizar. Sin traerlo del select, la comparación era siempre
  // NaN !== N (true) y el UPDATE corría en cada barrido para cada lead.
  kommo_stage_id: number | null;
  kommo_pipeline_id: number | null;
};

type Deps = {
  /** Dueño (token) de las reservas que toma esta invocación (0075). */
  runId: string;
  anthropic: Anthropic;
  agentId: string;
  environmentId: string;
  memstoreMaster: string;
  memstoreLeads: string;
  masterPath: string;
  leadsPath: string;
  kommoDomain: string;
  kommoToken: string;
  maxFollowUps: number;
  runStageIds: number[];
  runUserIds: number[];
  timezone: string;
  anthropicKey: string;
  agentModel: string;
  /** runtime_config.DREAMS_DIGEST: aprendizajes consolidados (mismo bloque que recibe generate-response). */
  dreamsDigest: string | null;
  pricingOverrideRaw: string | null;
};

// ---- Helpers de lectura ----

async function getTemplate(templateId: string): Promise<FollowUpTemplate | null> {
  const { data, error } = await supabase
    .from("follow_up_templates")
    .select("id, name, body, variables, salesbot_id, enabled")
    .eq("id", templateId)
    .maybeSingle();
  if (error) throw new Error(`getTemplate: ${error.message}`);
  return data;
}

async function getField(fieldId: string): Promise<FollowUpField | null> {
  const { data, error } = await supabase
    .from("follow_up_fields")
    .select("id, kommo_field_id")
    .eq("id", fieldId)
    .maybeSingle();
  if (error) throw new Error(`getField: ${error.message}`);
  return data;
}

async function getLead(leadId: string): Promise<LeadRow | null> {
  const { data, error } = await supabase
    .from("leads")
    .select("id, kommo_lead_id, display_name, kommo_stage_id, kommo_pipeline_id")
    .eq("id", leadId)
    .maybeSingle();
  if (error) throw new Error(`getLead: ${error.message}`);
  return data;
}

async function getMaxFollowUps(): Promise<number> {
  const { data } = await supabase
    .from("follow_up_config")
    .select("max_follow_ups")
    .eq("is_active", true)
    .maybeSingle();
  return (data as { max_follow_ups?: number } | null)?.max_follow_ups ?? 3;
}

// ---- Sesión CMA en modo seguimiento ----

async function runFollowUpAgent(opts: {
  lead: LeadRow;
  template: FollowUpTemplate;
  stepNumber: number;
  /** Historial determinístico (fetchLeadHistory): turnos lead/agente saneados, uno por línea. */
  history: string;
  deps: Deps;
}): Promise<string> {
  const { lead, template, stepNumber, history, deps } = opts;
  const { anthropic, agentId, environmentId, memstoreMaster, memstoreLeads, masterPath, leadsPath } = deps;

  // Construir lista de variables que la plantilla necesita completar
  const variablesBlock = template.variables.length > 0
    ? template.variables.map((v) => `- ${v.name}: ${v.description}`).join("\n")
    : "(sin variables)";

  const contextMessage = `MODO SEGUIMIENTO. No estás respondiendo un mensaje entrante: estás decidiendo si REACTIVAR a un lead inactivo con una plantilla de WhatsApp aprobada.

Fecha y hora actual: ${formatNow(deps.timezone)} (zona horaria ${deps.timezone}).

Lead: ${lead.id}. Si hace falta, consultá la voz del operador en ${masterPath}/voice/ y, si existe, ${leadsPath}/${lead.id}/learnings.md. El historial de la conversación está abajo: no lo busques en la memoria.
${deps.dreamsDigest ? `\naprendizajes_del_operador (reglas del operador aprendidas de conversaciones reales — PRIORIDAD MÁXIMA sobre tu voz base; aplicalas SIEMPRE):\n${deps.dreamsDigest}\n` : ""}
Historial reciente de la conversación (turnos en orden cronológico, uno por línea; t = hora UTC de cada turno: úsala para saber cuánto hace que el lead dejó de escribir). ${UNTRUSTED_NOTICE}
${history || "(sin mensajes previos)"}

PASO ${stepNumber} de la secuencia. Plantilla a enviar (texto fijo, ya aprobado por Meta):
"""
${template.body}
"""

Variables a completar (cada una rellena un campo de Kommo que la plantilla lee):
${variablesBlock}

Decidí:
- send: el lead sigue siendo un buen candidato a reactivar; completá TODAS las variables con valores apropiados a su contexto.
- skip: hoy no conviene enviar (sin perder el paso); se reintenta en la próxima ventana.
- stop: el lead pidió no ser contactado, ya compró, o claramente no corresponde seguir; corta la secuencia.

Respondé EXACTAMENTE en este formato y nada más:
<accion>send|skip|stop</accion>
<variables>{"nombre_var":"valor", ...}</variables>
<razon>1 frase</razon>`;

  // 1) Crear sesión con ambos memory stores (same pattern as generate-response)
  const session = await anthropic.beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
    title: `follow-up ${lead.id.slice(0, 8)} ${new Date().toISOString()}`,
    resources: [
      {
        type: "memory_store",
        memory_store_id: memstoreMaster,
        access: "read_only",
        instructions: MASTER_STORE_INSTRUCTIONS,
      },
      {
        type: "memory_store",
        memory_store_id: memstoreLeads,
        access: "read_write",
        instructions: leadsStoreInstructions(lead.id),
      },
    ],
  });

  // 2) Abrir stream y enviar mensaje
  const stream = await anthropic.beta.sessions.events.stream(session.id);

  await anthropic.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: contextMessage }],
      },
    ],
  });

  // 3) Loop de eventos (mirrors generate-response)
  let responseText = "";
  for await (const event of stream) {
    // deno-lint-ignore no-explicit-any
    const ev = event as any;
    if (ev.type === "agent.message") {
      responseText = "";
      for (const block of ev.content ?? []) {
        if (block.type === "text") responseText += block.text;
      }
    } else if (ev.type === "session.status_idle") {
      const stop = ev.stop_reason?.type;
      if (stop !== "requires_action") break;
    } else if (ev.type === "session.status_terminated") {
      break;
    } else if (ev.type === "session.error") {
      const msg = ev.error?.message ?? "session error";
      throw new Error(msg);
    }
  }

  // Captura fail-open del consumo de la sesión (W1 del verify: 5to call-site CMA).
  await captureSessionUsage(supabase, {
    apiKey: deps.anthropicKey,
    sessionId: session.id,
    component: "follow_up",
    model: deps.agentModel,
    leadId: lead.id,
    fallbackRuntimeMs: null,
    metadata: { step: stepNumber, template: template.name ?? template.id },
    pricingOverrideRaw: deps.pricingOverrideRaw,
  });

  return responseText;
}

// ---- Procesar un lead ----

// Sella leads.follow_up_last_skipped_at (0049): saca al lead de
// follow_up_due_leads por 1h tras un "skip", para no pagar una sesión CMA
// de re-evaluación en cada barrido de 5 min. Fail-open: si la columna aún
// no existe (función deployada antes que la migración), el update falla en
// silencio y el comportamiento vuelve al previo (re-evaluar cada barrido).
async function stampSkipCooldown(leadId: string): Promise<void> {
  const { error } = await supabase
    .from("leads")
    .update({ follow_up_last_skipped_at: new Date().toISOString() })
    .eq("id", leadId);
  if (error) console.warn("stampSkipCooldown:", error.message);
}

// ---- Reserva por lead y paso (0072, decisiones en _shared/followup-claim.ts) ----

/** attemptId: el intento que eligió la persona (reintento manual); la base exige que sea
 *  el último de ese paso (0077). null en el barrido. */
type RunMode = { manual: boolean; confirmResend: boolean; attemptId: string | null };

/** Cierra la reserva con la guarda de dueño. Lanza si la base no respondió (lo
 *  registra runClaimedFollowUp; el lease vence y la recuperación lo resuelve). */
async function closeClaim(id: string, owner: string, close: Exclude<ClaimClose, null>, maxFollowUps: number) {
  const { data, error } =
    close.rpc === "finish_follow_up"
      ? await supabase.rpc("finish_follow_up", {
          p_id: id,
          p_owner: owner,
          p_status: close.status,
          p_error: close.error,
          p_variables: close.variables,
          p_max_follow_ups: maxFollowUps,
        })
      : await supabase.rpc("release_follow_up_claim", { p_id: id, p_owner: owner });
  if (error) throw new Error(`${close.rpc}: ${error.message}`);
  if (data !== true) console.warn(`follow-up-scan: la reserva ${id} ya no era de este worker al cerrar (${close.rpc})`);
}

// El seguimiento pudo haberle llegado al lead y no se confirmó: no se reenvía solo.
async function alertUnconfirmed(leadId: string, error: string): Promise<void> {
  const { error: alertErr } = await insertAlert(supabase, {
    kind: "salesbot_not_delivered",
    severity: "warning",
    title: "Revisá si le llegó un seguimiento automático",
    description:
      "El envío de un seguimiento se cortó después de disparar la plantilla en Kommo y no se pudo confirmar si salió. " +
      "Para no mandárselo dos veces al cliente NO se reenvió. Revisá la conversación en Kommo y, si no le llegó, " +
      "reintentalo desde Seguimiento (te va a pedir confirmación).",
    ref_table: "leads",
    ref_id: leadId,
    metadata: { part: "follow_up", reason: "follow_up_unconfirmed", detail: error },
  });
  if (alertErr) console.warn("alert follow_up_unconfirmed:", alertErr);
}

/**
 * Procesa UN paso de UN lead con la reserva tomada. Nunca envía sin reserva: si otro
 * worker (barrido superpuesto o reintento manual) tiene el lead, devuelve `refused`.
 */
async function processLead(row: DueLeadRow, deps: Deps, mode: RunMode): Promise<LeadRunResult> {
  const result = await runClaimedFollowUp({
    claim: async () => {
      const { data, error } = await supabase.rpc("claim_follow_up", {
        p_lead_id: row.lead_id,
        p_step: row.step_number,
        p_template_id: row.template_id,
        p_owner: deps.runId,
        p_lease_seconds: FOLLOW_UP_LEASE_SECONDS,
        p_manual: mode.manual,
        p_confirm_resend: mode.confirmResend,
        p_attempt_id: mode.attemptId,
      });
      return interpretClaim(data, error);
    },
    mark: async (id, baseline, variables) => {
      const { data, error } = await supabase.rpc("mark_follow_up_sending", {
        p_id: id,
        p_owner: deps.runId,
        p_baseline: baseline,
        p_variables: variables,
      });
      if (error) console.error(`follow-up-scan: marca de envío de ${id} falló:`, error.message);
      return !error && data === true;
    },
    work: (markSending) => sendStep(row, deps, markSending),
    close: (id, close) => closeClaim(id, deps.runId, close, deps.maxFollowUps),
  });
  if (result.kind === "refused") {
    console.log(`follow-up-scan: lead ${row.lead_id} paso ${row.step_number} no reservado (${result.reason})`);
  } else if (result.kind === "unconfirmed") {
    await alertUnconfirmed(row.lead_id, result.error);
  }
  return result;
}

/**
 * Recupera reservas muertas (lease vencido). Las que no llegaron a marcar el envío las
 * cierra la RPC como interrumpidas (se reintentan); las que sí, se resuelven acá contra
 * Kommo SIN reenviar.
 */
async function recoverDead(owner: string, kommoDomain: string, kommoToken: string, maxFollowUps: number): Promise<void> {
  const { data, error } = await supabase.rpc("recover_dead_follow_up_claims", {
    p_owner: owner,
    p_lease_seconds: FOLLOW_UP_LEASE_SECONDS,
    p_limit: 20,
  });
  if (error) {
    console.error("follow-up-scan: recover_dead_follow_up_claims falló:", error.message);
    return;
  }
  for (const r of (data ?? []) as Array<{ follow_up_id: string; lead_id: string; action: string }>) {
    if (r.action !== "resolve") {
      console.warn(`follow-up-scan: seguimiento ${r.follow_up_id} interrumpido antes de enviar (${r.action})`);
      continue;
    }
    try {
      const { data: fu, error: fuErr } = await supabase
        .from("follow_ups")
        .select("baseline, sending_at, leads(kommo_lead_id)")
        .eq("id", r.follow_up_id)
        .maybeSingle();
      if (fuErr || !fu) throw new Error(fuErr?.message ?? "fila no encontrada");
      const leadRel = (fu as { leads: { kommo_lead_id: number } | { kommo_lead_id: number }[] | null }).leads;
      const kommoLeadId = Number((Array.isArray(leadRel) ? leadRel[0] : leadRel)?.kommo_lead_id);
      const { baseline, sending_at: sendingAt } = fu as { baseline: string[] | null; sending_at: string | null };
      // null = Kommo no se pudo leer (o no hay foto previa): queda sin confirmar, nunca enviado.
      const current =
        Number.isFinite(kommoLeadId) && baseline
          ? await fetchOutgoingEvents(kommoLeadId, kommoDomain, kommoToken)
          : null;
      const outcome = resolveDeadFollowUp(baseline, current, sendingAt);
      const close = closeFor(outcome);
      if (close) await closeClaim(r.follow_up_id, owner, close, maxFollowUps);
      if (outcome.kind === "unconfirmed") await alertUnconfirmed(r.lead_id, outcome.error);
      console.warn(`follow-up-scan: seguimiento interrumpido ${r.follow_up_id} resuelto como ${outcome.kind}`);
    } catch (err) {
      // El lease vence de nuevo y otro barrido lo retoma (sigue sin reenviarse).
      console.error(
        `follow-up-scan: resolver el seguimiento interrumpido ${r.follow_up_id} falló:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

/** El trabajo de un paso con la reserva tomada. Devuelve el resultado; nunca registra
 *  filas en follow_ups por su cuenta (eso lo hace el cierre de la reserva). */
async function sendStep(row: DueLeadRow, deps: Deps, markSending: SendingMark): Promise<FollowUpOutcome> {
  const leadId = row.lead_id;

  // Cargar lead
  const lead = await getLead(leadId);
  if (!lead) {
    console.warn(`follow-up-scan: lead ${leadId} not found, skipping`);
    return { kind: "released", reason: "el lead no existe" };
  }

  // --- Re-verificación de etapa EN VIVO (autoritativa) ---
  // El gate SQL filtró por leads.kommo_stage_id, que es un CACHE LOCAL: solo se
  // refresca con inbounds (process-inbound) o cuando el agente mueve la etapa.
  // Un lead ganado/perdido/convertido FUERA DE BANDA (vendedor o salesbot, sin
  // mensaje entrante) deja el cache stale y el gate lo dejaría pasar → seguimiento
  // a un cliente ya convertido. Acá consultamos la etapa real de Kommo antes de
  // gastar la sesión CMA y decidimos sobre ese valor.
  let liveStatusId: number;
  let livePipelineId: number | null = null;
  let liveResponsibleUserId: number | null;
  try {
    const liveStage = await fetchLeadStage(lead.kommo_lead_id, deps.kommoDomain, deps.kommoToken);
    liveStatusId = liveStage.statusId;
    livePipelineId = Number.isFinite(liveStage.pipelineId) ? liveStage.pipelineId : null;
    liveResponsibleUserId = liveStage.responsibleUserId;
  } catch (err) {
    // Fail-safe: si no podemos verificar la etapa, NO enviamos (mejor saltear que
    // arriesgar molestar a un convertido). Se reintenta en el próximo barrido.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`follow-up-scan: no se pudo verificar etapa en vivo de lead ${leadId}, skip: ${msg}`);
    return { kind: "released", reason: "no se pudo verificar la etapa del lead en Kommo; se reintenta en el próximo barrido" };
  }

  // Re-sincronizar el cache con el valor fresco (de paso, futuros barridos del gate
  // SQL ya verán la etapa correcta y no volverán a elegir este lead si no aplica).
  // Va por apply_lead_position (0061): etapa + pipeline juntos, respetando el
  // orden de eventos, y registra el movimiento si lo fue. Fail-open: un error acá
  // no debe impedir el chequeo de gates de más abajo (se usa liveStatusId directo).
  if (
    Number(liveStatusId) !== Number(lead.kommo_stage_id) ||
    (livePipelineId != null && Number(livePipelineId) !== Number(lead.kommo_pipeline_id))
  ) {
    const { error: posErr } = await supabase.rpc("apply_lead_position", {
      p_lead_id: leadId,
      p_stage_id: liveStatusId,
      p_pipeline_id: livePipelineId,
      p_at: new Date().toISOString(),
      p_moved_by: "kommo",
    });
    if (posErr) console.warn(`follow-up-scan: apply_lead_position de lead ${leadId} — fail-open: ${posErr.message}`);
  }

  // Guard duro: etapas terminales de Kommo (ganado 142 / perdido 143) cortan la
  // secuencia para siempre, sin importar el whitelist.
  if (liveStatusId === KOMMO_WON_STATUS || liveStatusId === KOMMO_LOST_STATUS) {
    await supabase.from("leads").update({ follow_up_status: "stopped" }).eq("id", leadId);
    console.log(`follow-up-scan: lead ${leadId} en etapa terminal ${liveStatusId} (ganado/perdido), stop`);
    return { kind: "released", reason: "el lead está ganado o perdido en Kommo: se detuvo la secuencia" };
  }

  // Whitelist en vivo: si hay etapas configuradas y la etapa REAL no está entre
  // ellas, salteamos (no cambia el estado; si vuelve a la etapa permitida, retoma).
  if (deps.runStageIds.length > 0 && !deps.runStageIds.includes(Number(liveStatusId))) {
    console.log(`follow-up-scan: lead ${leadId} etapa real ${liveStatusId} fuera del whitelist, skip`);
    return { kind: "released", reason: "la etapa real del lead en Kommo está fuera de las etapas configuradas" };
  }

  // Whitelist de USUARIO RESPONSABLE (vendedor) en vivo: si hay usuarios
  // configurados, solo se hace seguimiento a leads cuyo responsable real esté en
  // la lista. Un lead sin responsable (null) no matchea → skip. Se combina con
  // la etapa en AND. No cambia el estado (si lo reasignan, retoma).
  if (
    deps.runUserIds.length > 0 &&
    (liveResponsibleUserId == null || !deps.runUserIds.includes(Number(liveResponsibleUserId)))
  ) {
    console.log(`follow-up-scan: lead ${leadId} responsable ${liveResponsibleUserId} fuera del whitelist, skip`);
    return { kind: "released", reason: "el responsable del lead en Kommo está fuera de los usuarios configurados" };
  }

  // Cargar template y pre-validar: existente, habilitado, salesbot_id presente,
  // variables mapeadas. Un error de configuración queda como intento `failed`.
  if (!row.template_id) {
    console.warn(`follow-up-scan: step ${row.step_number} has no template`);
    return { kind: "failed", error: "step has no template_id" };
  }
  const template = await getTemplate(row.template_id);
  if (!template || !template.enabled) return { kind: "failed", error: "template not found or disabled" };
  if (!template.salesbot_id) return { kind: "failed", error: "unmapped: salesbot_id is null" };
  // Verificar que todas las variables tengan un campo de Kommo asignado
  // (kommo_field_id directo, o field_id legacy).
  for (const variable of template.variables) {
    if (typeof variable.kommo_field_id !== "number" && !variable.field_id) {
      return { kind: "failed", error: `unmapped: variable "${variable.name}" sin campo de Kommo` };
    }
  }

  // Cargar mensajes recientes
  // Misma fuente que generate-response: respuestas del agente incluidas (viven
  // en drafts, no en messages) y texto del lead saneado. fail-soft: "" si falla.
  const history = await fetchLeadHistory(supabase, leadId, { maxMessages: 20, truncateChars: 400, timestamps: true });

  // Ejecutar sesión CMA en modo seguimiento
  let rawOutput: string;
  try {
    rawOutput = await runFollowUpAgent({ lead, template, stepNumber: row.step_number, history, deps });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`follow-up-scan: CMA session failed for lead ${leadId}:`, msg);
    return { kind: "failed", error: `CMA session error: ${msg}` };
  }

  // Parsear acción y variables (mirrors <respuesta> extraction in generate-response)
  const actionMatch = rawOutput.match(/<accion>\s*(send|skip|stop)\s*<\/accion>/i);
  const action = actionMatch?.[1]?.toLowerCase();
  const razon = rawOutput.match(/<razon>([\s\S]*?)<\/razon>/i)?.[1]?.trim() || null;

  if (!action) {
    // Salida malformada → skip + log. Sella el cooldown igual que un skip:
    // sin el sello, el lead volvía a evaluarse en el próximo barrido.
    console.warn(`follow-up-scan: malformed output for lead ${leadId}, treating as skip`);
    await stampSkipCooldown(leadId);
    return { kind: "released", reason: "el agente devolvió una respuesta ilegible; se reintenta más tarde" };
  }

  if (action === "skip") {
    // Cooldown de skip (0049): antes NO se tocaba ningún estado y el lead
    // volvía a ser elegible en el PRÓXIMO barrido de 5 min — cada
    // re-evaluación es una sesión CMA completa (hasta 12/hora por lead, y
    // ≥5 leads en skip acaparaban el cupo p_limit=5 de cada ciclo). El
    // sello lo excluye de follow_up_due_leads por 1 hora.
    await stampSkipCooldown(leadId);
    return { kind: "released", reason: `el agente decidió no escribir por ahora${razon ? `: ${razon}` : ""}` };
  }

  if (action === "stop") {
    await supabase
      .from("leads")
      .update({ follow_up_status: "stopped" })
      .eq("id", leadId);
    return { kind: "released", reason: `el agente cortó la secuencia${razon ? `: ${razon}` : ""}` };
  }

  // action === "send"
  // Variables de la plantilla (_shared/followup-variables.ts): solo propiedades PROPIAS
  // del JSON del agente, en un mapa sin prototipo. Una clave como "constructor" no
  // resuelve a lo heredado de Object.prototype ni pasa por «completa».
  const vars = resolveTemplateVariables(
    rawOutput.match(/<variables>([\s\S]*?)<\/variables>/i)?.[1],
    template.variables.map((v) => v.name)
  );
  if (!vars.ok && vars.reason === "invalid_json") {
    // "treating as skip" ⇒ mismo cooldown (0049): un template que produce
    // JSON roto de forma consistente re-quemaría una sesión CMA por barrido.
    console.warn(`follow-up-scan: failed to parse <variables> JSON for lead ${leadId}, treating as skip`);
    await stampSkipCooldown(leadId);
    return { kind: "released", reason: "el agente devolvió las variables de la plantilla ilegibles; se reintenta más tarde" };
  }
  if (!vars.ok) {
    // "treating as skip" ⇒ mismo cooldown (0049): una variable irresoluble
    // es un error de configuración persistente, no transitorio.
    console.warn(`follow-up-scan: missing variable "${vars.name}" for lead ${leadId}, treating as skip`);
    await stampSkipCooldown(leadId);
    return { kind: "released", reason: `el agente no completó la variable "${vars.name}"; se reintenta más tarde` };
  }
  const resolvedVars = vars.values;

  // Verificador de texto saliente (_shared/outbound.ts): las variables que el
  // modelo completó son texto que el cliente va a leer en la plantilla. Se verifican
  // TODAS antes de escribir la primera, para no dejar campos a medio escribir en
  // Kommo. Con residuo interno: failed con el motivo, alerta y cooldown (la salida
  // del modelo se repetiría igual en el próximo barrido).
  for (const variable of template.variables) {
    const fuga = outboundLeak(resolvedVars[variable.name]);
    if (fuga) return await blockFollowUp(leadId, resolvedVars, variable.name, fuga);
  }

  // Enviar: foto de salientes → PATCH de los campos → marca write-ahead → salesbot.
  // Escribir los campos no le manda nada al cliente; lo envía el salesbot, y antes de
  // dispararlo se fija la marca (con la foto, para resolver un corte sin reenviar). Si
  // la reserva ya no es nuestra, markSending lanza y NO se dispara nada. Si Kommo no se
  // pudo leer, la foto queda null (no «sin salientes»): un corte posterior se resuelve
  // «sin confirmar», nunca «enviado».
  const baseline = await fetchOutgoingEventIds(lead.kommo_lead_id, deps.kommoDomain, deps.kommoToken);
  try {
    for (const variable of template.variables) {
      const kommoFieldId = await resolveKommoFieldId(variable);
      if (kommoFieldId == null) {
        throw new Error(`variable "${variable.name}" sin campo de Kommo resoluble`);
      }
      await writeClientText({
        kind: "follow_up",
        kommoLeadId: lead.kommo_lead_id,
        fieldId: kommoFieldId,
        text: resolvedVars[variable.name],
        kommoDomain: deps.kommoDomain,
        kommoToken: deps.kommoToken,
      });
    }
    await markSending(baseline ? [...baseline] : null, resolvedVars);
    await runSalesbot(template.salesbot_id, lead.kommo_lead_id, deps.kommoDomain, deps.kommoToken);
  } catch (err) {
    if (err instanceof FollowUpLeaseLostError) throw err;
    if (err instanceof OutboundBlockedError) {
      return await blockFollowUp(leadId, resolvedVars, "(variable)", err.reason);
    }
    // Antes de la marca: failed (reintentable). Después de la marca, runClaimedFollowUp
    // lo convierte en «sin confirmar» (el salesbot pudo haber salido): nunca se reenvía solo.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`follow-up-scan: Kommo API error for lead ${leadId}:`, msg);
    return { kind: "failed", error: `Kommo API error: ${msg}`, variables: resolvedVars };
  }

  // Éxito: el cierre de la reserva registra `sent` y avanza el lead en una transacción.
  return { kind: "sent", variables: resolvedVars };
}

// Seguimiento bloqueado por el verificador de texto saliente: nada se escribió en
// Kommo. Queda `failed` con el motivo (visible en /seguimiento), con alerta, y sella
// el cooldown de skip (0049) para no re-quemar una sesión del agente por barrido.
async function blockFollowUp(
  leadId: string,
  vars: Record<string, string>,
  variableName: string,
  reason: string
): Promise<FollowUpOutcome> {
  console.error(`follow-up-scan: seguimiento de lead ${leadId} bloqueado (${variableName}): ${reason}`);
  const { error: alertErr } = await insertAlert(supabase, {
    kind: "outbound_blocked",
    severity: "warning",
    title: "Se bloqueó un seguimiento automático",
    description:
      `El texto que el agente armó para la plantilla traía residuo interno (${reason}) y no se envió. ` +
      "No se escribió nada en Kommo. Revisá la plantilla y las instrucciones del seguimiento.",
    ref_table: "leads",
    ref_id: leadId,
    metadata: { part: "follow_up", reason, variable: variableName },
  });
  if (alertErr) console.warn("alert outbound_blocked:", alertErr);
  await stampSkipCooldown(leadId);
  return { kind: "failed", error: `bloqueado por guard: ${reason} (variable ${variableName})`, variables: vars };
}

// ---- Reintento MANUAL de un intento puntual ----
// Lo dispara el botón "Reintentar" de /seguimiento, sobre un intento que quedó en
// `failed`. Ningún camino de fallo avanza el estado del lead, así que el paso NO se
// consumió: reintentar es volver a correr el mismo paso, sin tocar nada.
//
// Es POR INTENTO: el panel manda `follow_up_id` + `step` de la fila. Solo se reintenta
// si ese paso es el que el lead debe recibir ahora (follow_up_step + 1) y ese intento
// es el último de ese paso para ese lead (lo verifica la base al reservar, 0077); si
// no, responde 409 (`conflict`) con el motivo: la persona miraba una fila vieja.
//
// Es una decisión humana explícita (mismo criterio que el envío manual de
// publish-to-kommo), así que saltea la rotación del barrido automático y el
// piso `min_gap_hours`. Lo que NO saltea son los gates que protegen al
// cliente: opt-out, estados terminales, tope de seguimientos, y — dentro de
// processLead — la verificación EN VIVO de etapa y responsable contra Kommo.
// El horario laboral se respeta salvo `force: true`, que la UI pide confirmando.
//
// Toma la MISMA reserva por lead y paso que el barrido (0075): si el barrido lo está
// enviando, el reintento no envía (responde el motivo). Un paso «sin confirmar» (pudo
// haberle llegado) solo se reenvía con `confirm_resend: true`, que la UI pide aparte.
//
// El gate en sí (`evaluateRetryGate` / `retryOutcomeFor`) vive en
// `_shared/followup-retry.ts`, puro y probado sin tocar Supabase ni Kommo.
type RetryResult = RetryOutcome & { outsideHours?: boolean };

async function retryOne(
  req: Extract<ScanRequest, { kind: "retry" }>,
  deps: Deps
): Promise<RetryResult> {
  const { data: attempt, error: attemptErr } = await supabase
    .from("follow_ups")
    .select("id, lead_id, step, status")
    .eq("id", req.followUpId)
    .maybeSingle();
  if (attemptErr) throw new Error(`leer el intento ${req.followUpId}: ${attemptErr.message}`);

  const { data: lead, error: leadErr } = attempt
    ? await supabase
        .from("leads")
        .select("id, follow_up_step, follow_up_status, opted_out, kommo_lead_id")
        .eq("id", attempt.lead_id)
        .maybeSingle()
    : { data: null, error: null };
  if (leadErr) throw new Error(`leer el lead del intento ${req.followUpId}: ${leadErr.message}`);

  const { data: cfg } = await supabase
    .from("follow_up_config")
    .select(
      "enabled, max_follow_ups, timezone, business_hours, business_hours_start, business_hours_end, active_days"
    )
    .eq("is_active", true)
    .maybeSingle();

  const gate = evaluateRetryGate(req.step, attempt, lead, cfg);
  if (!gate.ok) return { ok: false, skipped: gate.reason, ...(gate.conflict ? { conflict: true } : {}) };
  // gate.ok implica que el intento existe (evaluateRetryGate lo exige).
  if (!attempt) return { ok: false, conflict: true, skipped: "ese intento de seguimiento ya no existe" };

  if (!req.force) {
    const bh: BusinessHoursConfig = {
      timezone: (cfg?.timezone as string) || DEFAULT_TIMEZONE,
      business_hours: (cfg?.business_hours as BusinessHoursConfig["business_hours"]) ?? null,
      business_hours_start: Number(cfg?.business_hours_start ?? 9),
      business_hours_end: Number(cfg?.business_hours_end ?? 20),
      active_days: ((cfg?.active_days as number[] | null) ?? [1, 2, 3, 4, 5, 6]).map(Number),
    };
    if (!isBusinessHours(bh)) {
      return {
        ok: false,
        outsideHours: true,
        skipped: "fuera del horario laboral configurado",
      };
    }
  }

  const { data: stepCfg } = await supabase
    .from("follow_up_steps")
    .select("step_number, delay_hours, template_id")
    .eq("step_number", gate.step)
    .eq("enabled", true)
    .maybeSingle();
  if (!stepCfg) {
    return { ok: false, skipped: `no hay un paso ${gate.step} habilitado en la secuencia` };
  }

  const result = await processLead(
    {
      lead_id: attempt.lead_id,
      step_number: Number(stepCfg.step_number),
      delay_hours: Number(stepCfg.delay_hours),
      template_id: (stepCfg.template_id as string | null) ?? null,
    },
    deps,
    { manual: true, confirmResend: req.confirmResend, attemptId: req.followUpId }
  );
  return retryOutcomeFor(result);
}

// ---- Entry point ----

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("follow-up-scan OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  // Gate interno: esta función NO es un webhook público (ver _shared/auth.ts).
  {
    const denied = await authorizeInternal(req, supabase);
    if (denied) return denied;
  }

  // ¿Reintento manual de un intento? El botón manda { follow_up_id, step, force?, confirm_resend? }.
  // Sin body (o sin follow_up_id) = barrido automático, comportamiento de siempre.
  let scanReq: ScanRequest = { kind: "sweep" };
  try {
    scanReq = parseScanRequest(await req.json());
  } catch {
    // sin body = barrido automático
  }
  if (scanReq.kind === "invalid") {
    return new Response(JSON.stringify({ ok: false, error: scanReq.error }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const manual = scanReq.kind === "retry" ? scanReq : null;

  try {
    // Apagado total: corta ANTES de tocar Anthropic (el follow-up usa el
    // agente CMA completo, no solo un template). Sin excepción para el
    // reintento manual: si el operador cortó todo, un click desde el
    // dashboard no debe saltarse el freno — hay que apagar el switch primero.
    // follow-up-scan no lee kommo_publish_config para nada más, así que usa
    // isSystemHalted (query aparte cacheada 60s — fail-open, ver
    // _shared/halt.ts).
    if (await isSystemHalted(supabase)) {
      logHalted("follow-up-scan");
      return haltedResponse({ processed: 0 });
    }

    // Resolver toda la config ANTES del waitUntil boundary
    // (mismo patrón de generate-response para evitar drafts stuck)
    const runtimeCfg = await loadConfig(supabase);
    const kommoDomain = runtimeCfg.require("KOMMO_API_DOMAIN");
    const kommoToken  = runtimeCfg.require("KOMMO_ACCESS_TOKEN");
    const maxFollowUps = await getMaxFollowUps();
    // Dueño de las reservas que tome esta invocación (0075).
    const runId = crypto.randomUUID();

    // Reservas muertas (worker cortado a mitad): antes de elegir leads nuevos. No usa
    // Anthropic ni envía nada (solo resuelve contra Kommo), así que corre aunque el
    // techo de gasto frene el resto.
    await recoverDead(runId, kommoDomain, kommoToken, maxFollowUps);

    // Techo de gasto mensual (>=100%): el seguimiento corre el agente CMA
    // completo, así que se frena igual que las respuestas. Los leads siguen
    // elegibles: se retoman solos cuando sube el techo o cambia el mes.
    const budget = await getBudgetGate(supabase, runtimeCfg);
    if (budget.blockGenerate) {
      return new Response(
        JSON.stringify({ ok: true, processed: 0, skipped: "budget exceeded", pct: budget.pct }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    const agentId        = runtimeCfg.require("ANTHROPIC_AGENT_ID");
    const environmentId  = runtimeCfg.require("ANTHROPIC_ENVIRONMENT_ID");
    const memstoreMaster = runtimeCfg.require("ANTHROPIC_MEMORY_MASTER_ID");
    const memstoreLeads  = runtimeCfg.require("ANTHROPIC_MEMORY_LEADS_ID");
    const masterStoreName = runtimeCfg.getOr("MEMORY_STORE_MASTER_NAME", "master");
    const leadsStoreName  = runtimeCfg.getOr("MEMORY_STORE_LEADS_NAME", "leads");
    const masterPath = `/mnt/memory/${masterStoreName}`;
    const leadsPath  = `/mnt/memory/${leadsStoreName}`;
    const anthropic  = createAnthropicClient(runtimeCfg.require("ANTHROPIC_API_KEY"), supabase);
    const anthropicKey = runtimeCfg.require("ANTHROPIC_API_KEY");

    // El barrido automático resuelve su cola ANTES de construir deps, igual que
    // siempre: si no hay nada pendiente sale sin exigir el resto de la config. El
    // reintento manual no pasa por la RPC — su gate es retryOne.
    let rows: DueLeadRow[] = [];
    if (!manual) {
      // SQL gate: retorna leads elegibles (o vacío si config deshabilitada / fuera de
      // horario). Excluye los que tienen el paso reservado, enviado o sin confirmar
      // (0075); igual, la reserva de processLead es la que decide de forma atómica.
      const { data: due, error: rpcError } = await supabase.rpc("follow_up_due_leads", { p_limit: 5 });
      if (rpcError) throw new Error(`follow_up_due_leads RPC: ${rpcError.message}`);
      rows = (due ?? []) as DueLeadRow[];

      if (rows.length === 0) {
        return new Response(
          JSON.stringify({ ok: true, processed: 0 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    }

    const { data: cfgRow } = await supabase
      .from("follow_up_config")
      .select("timezone, run_stage_ids")
      .eq("is_active", true)
      .maybeSingle();
    const timezone = (cfgRow?.timezone as string) || DEFAULT_TIMEZONE;
    const runStageIds = ((cfgRow?.run_stage_ids as number[] | null) ?? []).map(Number);
    // run_user_ids se lee aparte: si la migración 0041 aún no se aplicó, la columna
    // no existe y el select falla — leerlo en su propio query evita que ese fallo
    // arrastre y desactive el whitelist de etapas. Sin columna → [] (= todos).
    const { data: userCfgRow } = await supabase
      .from("follow_up_config")
      .select("run_user_ids")
      .eq("is_active", true)
      .maybeSingle();
    const runUserIds = ((userCfgRow?.run_user_ids as number[] | null) ?? []).map(Number);
    const deps: Deps = {
      runId,
      anthropic, agentId, environmentId,
      memstoreMaster, memstoreLeads,
      masterPath, leadsPath,
      kommoDomain, kommoToken,
      maxFollowUps,
      runStageIds,
      runUserIds,
      timezone,
      anthropicKey,
      agentModel: modelFor(runtimeCfg, "AGENT_MODEL"),
      dreamsDigest: (runtimeCfg.get("DREAMS_DIGEST") ?? "").trim() || null,
      pricingOverrideRaw: runtimeCfg.get("AI_PRICING_OVERRIDES") ?? null,
    };

    // Reintento manual: se ESPERA el resultado porque el operador lo ve en la UI
    // para saber si salió o por qué no. Pero va sostenido con keepAlive (waitUntil):
    // si el panel corta (timeout del host serverless), el reintento termina igual y
    // cierra su reserva. Si el runtime lo mata igual, la reserva vence y la
    // recuperación la resuelve sin reenviar (0075).
    if (manual) {
      const res = await keepAlive(retryOne(manual, deps));
      return new Response(JSON.stringify(res), {
        status: res.conflict ? 409 : 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Loop secuencial dentro de waitUntil:
    // Secuencial para no saturar la API de Anthropic Managed Agents.
    // processLead toma la reserva de cada lead justo antes de procesarlo y la cierra
    // al terminar; un error en un lead no mata el sweep.
    const slowWork = (async () => {
      for (const row of rows) {
        try {
          await processLead(row, deps, { manual: false, confirmResend: false, attemptId: null });
        } catch (err) {
          // Solo fallas de infraestructura fuera de la reserva (p. ej. la alerta): si
          // la reserva quedó tomada, vence y la recupera el próximo barrido.
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`follow-up-scan: unhandled error for lead ${row.lead_id}:`, msg);
        }
      }
    })();

    // @ts-ignore: EdgeRuntime existe en Supabase
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(slowWork);
    } else {
      await slowWork;
    }

    return new Response(
      JSON.stringify({ ok: true, picked: rows.length }),
      { status: 202, headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("follow-up-scan error:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
});
