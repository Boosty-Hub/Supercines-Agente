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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { authorizeInternal } from "../_shared/auth.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.95.1";
import { loadConfig } from "../_shared/config.ts";
import {
  runSalesbot,
  fetchLeadStage,
  KOMMO_WON_STATUS,
  KOMMO_LOST_STATUS,
} from "../_shared/kommo.ts";
import { captureSessionUsage } from "../_shared/usage.ts";
import { createAnthropicClient } from "../_shared/anthropic-client.ts";
import { isSystemHalted, haltedResponse, logHalted } from "../_shared/halt.ts";
import { modelFor } from "../_shared/models.ts";
import { isBusinessHours, type BusinessHoursConfig, DEFAULT_TIMEZONE } from "../_shared/business-hours.ts";
import { evaluateRetryGate, interpretRetryOutcome } from "../_shared/followup-retry.ts";
import { getBudgetGate } from "../_shared/budget.ts";
import { leadsStoreInstructions, MASTER_STORE_INSTRUCTIONS } from "../_shared/memory-instructions.ts";
import { fetchLeadHistory } from "../_shared/history.ts";
import { OutboundBlockedError, outboundLeak, writeClientText } from "../_shared/outbound.ts";
import { UNTRUSTED_NOTICE } from "../_shared/untrusted.ts";

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

async function processLead(row: DueLeadRow, deps: Deps): Promise<void> {
  const leadId = row.lead_id;

  // Cargar lead
  const lead = await getLead(leadId);
  if (!lead) {
    console.warn(`follow-up-scan: lead ${leadId} not found, skipping`);
    return;
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
    return;
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
    return;
  }

  // Whitelist en vivo: si hay etapas configuradas y la etapa REAL no está entre
  // ellas, salteamos (no cambia el estado; si vuelve a la etapa permitida, retoma).
  if (deps.runStageIds.length > 0 && !deps.runStageIds.includes(Number(liveStatusId))) {
    console.log(`follow-up-scan: lead ${leadId} etapa real ${liveStatusId} fuera del whitelist, skip`);
    return;
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
    return;
  }

  // Cargar template
  if (!row.template_id) {
    console.warn(`follow-up-scan: step ${row.step_number} has no template, inserting failed`);
    await supabase.from("follow_ups").insert({
      lead_id: leadId,
      template_id: null,
      step: row.step_number,
      status: "failed",
      variables: {},
      error: "step has no template_id",
    });
    return;
  }

  const template = await getTemplate(row.template_id);

  // Pre-validate: template existente, enabled, salesbot_id presente, variables mapeadas
  if (!template || !template.enabled) {
    await supabase.from("follow_ups").insert({
      lead_id: leadId,
      template_id: row.template_id,
      step: row.step_number,
      status: "failed",
      variables: {},
      error: "template not found or disabled",
    });
    return;
  }
  if (!template.salesbot_id) {
    await supabase.from("follow_ups").insert({
      lead_id: leadId,
      template_id: template.id,
      step: row.step_number,
      status: "failed",
      variables: {},
      error: "unmapped: salesbot_id is null",
    });
    return;
  }
  // Verificar que todas las variables tengan un campo de Kommo asignado
  // (kommo_field_id directo, o field_id legacy).
  for (const variable of template.variables) {
    if (typeof variable.kommo_field_id !== "number" && !variable.field_id) {
      await supabase.from("follow_ups").insert({
        lead_id: leadId,
        template_id: template.id,
        step: row.step_number,
        status: "failed",
        variables: {},
        error: `unmapped: variable "${variable.name}" sin campo de Kommo`,
      });
      return;
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
    await supabase.from("follow_ups").insert({
      lead_id: leadId,
      template_id: template.id,
      step: row.step_number,
      status: "failed",
      variables: {},
      error: `CMA session error: ${msg}`,
    });
    return;
  }

  // Parsear acción y variables (mirrors <respuesta> extraction in generate-response)
  const actionMatch = rawOutput.match(/<accion>\s*(send|skip|stop)\s*<\/accion>/i);
  const action = actionMatch?.[1]?.toLowerCase();

  if (!action) {
    // Salida malformada → skip + log. Sella el cooldown igual que un skip:
    // sin el sello, el lead volvía a evaluarse en el próximo barrido.
    console.warn(`follow-up-scan: malformed output for lead ${leadId}, treating as skip`);
    await stampSkipCooldown(leadId);
    return;
  }

  if (action === "skip") {
    // Cooldown de skip (0049): antes NO se tocaba ningún estado y el lead
    // volvía a ser elegible en el PRÓXIMO barrido de 5 min — cada
    // re-evaluación es una sesión CMA completa (hasta 12/hora por lead, y
    // ≥5 leads en skip acaparaban el cupo p_limit=5 de cada ciclo). El
    // sello lo excluye de follow_up_due_leads por 1 hora.
    await stampSkipCooldown(leadId);
    return;
  }

  if (action === "stop") {
    await supabase
      .from("leads")
      .update({ follow_up_status: "stopped" })
      .eq("id", leadId);
    return;
  }

  // action === "send"
  // Parsear variables del JSON
  let resolvedVars: Record<string, string> = {};
  const varsRaw = rawOutput.match(/<variables>([\s\S]*?)<\/variables>/i)?.[1];
  if (varsRaw) {
    try {
      const parsed = JSON.parse(varsRaw.trim());
      if (typeof parsed === "object" && parsed !== null) {
        resolvedVars = parsed as Record<string, string>;
      }
    } catch {
      // "treating as skip" ⇒ mismo cooldown (0049): un template que produce
      // JSON roto de forma consistente re-quemaría una sesión CMA por barrido.
      console.warn(`follow-up-scan: failed to parse <variables> JSON for lead ${leadId}, treating as skip`);
      await stampSkipCooldown(leadId);
      return;
    }
  }

  // Verificar que todas las variables requeridas estén presentes
  for (const variable of template.variables) {
    if (!resolvedVars[variable.name]) {
      // "treating as skip" ⇒ mismo cooldown (0049): una variable irresoluble
      // es un error de configuración persistente, no transitorio.
      console.warn(`follow-up-scan: missing variable "${variable.name}" for lead ${leadId}, treating as skip`);
      await stampSkipCooldown(leadId);
      return;
    }
  }

  // Verificador de texto saliente (_shared/outbound.ts): las variables que el
  // modelo completó son texto que el cliente va a leer en la plantilla. Se verifican
  // TODAS antes de escribir la primera, para no dejar campos a medio escribir en
  // Kommo. Con residuo interno: failed con el motivo, alerta y cooldown (la salida
  // del modelo se repetiría igual en el próximo barrido).
  for (const variable of template.variables) {
    const fuga = outboundLeak(resolvedVars[variable.name]);
    if (fuga) {
      await blockFollowUp(leadId, template.id, row.step_number, resolvedVars, variable.name, fuga);
      return;
    }
  }

  // Enviar: PATCH Kommo fields + run salesbot
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
    await runSalesbot(template.salesbot_id, lead.kommo_lead_id, deps.kommoDomain, deps.kommoToken);
  } catch (err) {
    if (err instanceof OutboundBlockedError) {
      await blockFollowUp(leadId, template.id, row.step_number, resolvedVars, "(variable)", err.reason);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`follow-up-scan: Kommo API error for lead ${leadId}:`, msg);
    // On Kommo error: log + failed row, do NOT advance lead state
    await supabase.from("follow_ups").insert({
      lead_id: leadId,
      template_id: template.id,
      step: row.step_number,
      status: "failed",
      variables: resolvedVars,
      error: `Kommo API error: ${msg}`,
    });
    return;
  }

  // Éxito: insertar log + actualizar estado del lead
  await supabase.from("follow_ups").insert({
    lead_id: leadId,
    template_id: template.id,
    step: row.step_number,
    status: "sent",
    variables: resolvedVars,
  });

  const newStep = row.step_number;
  const newStatus = newStep >= deps.maxFollowUps ? "exhausted" : "active";
  await supabase
    .from("leads")
    .update({
      follow_up_status: newStatus,
      follow_up_step: newStep,
      follow_up_last_sent_at: new Date().toISOString(),
    })
    .eq("id", leadId);
}

// Seguimiento bloqueado por el verificador de texto saliente: nada se escribió en
// Kommo. Queda `failed` con el motivo (visible en /seguimiento), con alerta, y sella
// el cooldown de skip (0049) para no re-quemar una sesión del agente por barrido.
async function blockFollowUp(
  leadId: string,
  templateId: string,
  step: number,
  vars: Record<string, string>,
  variableName: string,
  reason: string
): Promise<void> {
  console.error(`follow-up-scan: seguimiento de lead ${leadId} bloqueado (${variableName}): ${reason}`);
  await supabase.from("follow_ups").insert({
    lead_id: leadId,
    template_id: templateId,
    step,
    status: "failed",
    variables: vars,
    error: `bloqueado por guard: ${reason} (variable ${variableName})`,
  });
  const { error: alertErr } = await supabase.from("alerts").insert({
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
  if (alertErr) console.warn("alert outbound_blocked:", alertErr.message);
  await stampSkipCooldown(leadId);
}

// ---- Reintento MANUAL de un lead puntual ----
// Lo dispara el botón "Reintentar" de la pestaña Seguimientos del inbox, sobre un
// seguimiento que quedó en `failed`. Ningún camino de fallo avanza el estado del
// lead, así que el paso NO se consumió: reintentar es volver a correr el mismo
// paso, sin tocar nada.
//
// Es una decisión humana explícita (mismo criterio que el envío manual de
// publish-to-kommo), así que saltea la rotación del barrido automático y el
// piso `min_gap_hours`. Lo que NO saltea son los gates que protegen al
// cliente: opt-out, estados terminales, tope de seguimientos, y — dentro de
// processLead — la verificación EN VIVO de etapa y responsable contra Kommo.
// El horario laboral se respeta salvo `force: true`, que la UI pide confirmando.
//
// El gate en sí (`evaluateRetryGate` / `interpretRetryOutcome`) vive en
// `_shared/followup-retry.ts`, puro y probado sin tocar Supabase ni Kommo.
type RetryResult = {
  ok: boolean;
  skipped?: string;
  outsideHours?: boolean;
  status?: string;
  error?: string | null;
};

async function retryOne(leadId: string, force: boolean, deps: Deps): Promise<RetryResult> {
  const { data: lead } = await supabase
    .from("leads")
    .select("id, follow_up_step, follow_up_status, opted_out, kommo_lead_id")
    .eq("id", leadId)
    .maybeSingle();

  const { data: cfg } = await supabase
    .from("follow_up_config")
    .select(
      "enabled, max_follow_ups, timezone, business_hours, business_hours_start, business_hours_end, active_days"
    )
    .eq("is_active", true)
    .maybeSingle();

  const gate = evaluateRetryGate(lead, cfg);
  if (!gate.ok) return { ok: false, skipped: gate.reason };

  if (!force) {
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

  await processLead(
    {
      lead_id: leadId,
      step_number: Number(stepCfg.step_number),
      delay_hours: Number(stepCfg.delay_hours),
      template_id: (stepCfg.template_id as string | null) ?? null,
    },
    deps
  );

  // processLead no devuelve nada: inserta la fila del intento. Leemos la más
  // nueva para poder decirle al operador qué pasó de verdad, en vez de un "listo"
  // que igual pudo haber fallado. Si no insertó nada, fue un skip silencioso de
  // los de adentro (etapa/responsable fuera del whitelist, o el agente decidió
  // no escribir).
  const { data: last } = await supabase
    .from("follow_ups")
    .select("status, error, step")
    .eq("lead_id", leadId)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return interpretRetryOutcome(last, stepCfg.step_number);
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

    const kommoDomain    = runtimeCfg.require("KOMMO_API_DOMAIN");
    const kommoToken     = runtimeCfg.require("KOMMO_ACCESS_TOKEN");
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

    // SQL gate: retorna leads elegibles (o vacío si config deshabilitada / fuera de horario)
    const { data: due, error: rpcError } = await supabase.rpc("follow_up_due_leads", { p_limit: 5 });
    if (rpcError) throw new Error(`follow_up_due_leads RPC: ${rpcError.message}`);

    const rows = (due ?? []) as DueLeadRow[];
    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, processed: 0 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    const maxFollowUps = await getMaxFollowUps();
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

    // Loop secuencial dentro de waitUntil:
    // Secuencial para no saturar la API de Anthropic Managed Agents.
    // Un error en un lead no mata el sweep (try/catch por lead).
    const slowWork = (async () => {
      for (const row of rows) {
        try {
          await processLead(row, deps);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`follow-up-scan: unhandled error for lead ${row.lead_id}:`, msg);
          try {
            await supabase.from("follow_ups").insert({
              lead_id: row.lead_id,
              template_id: row.template_id,
              step: row.step_number,
              status: "failed",
              variables: {},
              error: `unhandled: ${msg}`,
            });
          } catch {
            // best-effort
          }
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
