// Edge Function: generate-response
// Orquesta una sesión CMA para responder a un mensaje inbound clasificado.
//
//  - Toma el mensaje (POST {message_id} o el más viejo sin draft)
//  - Abre sesión con master (read_only) y leads (read_write) Memory Stores
//  - Inyecta contexto del lead + clasificación
//  - Stream events; resuelve custom_tool_use de `search_kb` con embed + RPC
//  - Capturas agent.message, guarda como draft

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@0.95.1";
import { loadConfig, type ConfigReader } from "../_shared/config.ts";
import { authorizeInternal, callInternal, internalHeaders } from "../_shared/auth.ts";
import { recordUsage, captureSessionUsage, recordFailedLlmUsage } from "../_shared/usage.ts";
import {
  moveLeadStage,
  addLeadNote,
  addLeadTags,
  fetchPipelineStages,
  fetchEntityFieldDefs,
  patchEntityFieldTyped,
  resolveFieldValue,
  type KommoStageLite,
  type KommoFieldDef,
} from "../_shared/kommo.ts";
import { getBcvRate } from "../_shared/exchange.ts";
import { resolverEtapa, type ResultadoEtapa } from "../_shared/crm-etapa.ts";
import { construirNotaTransferencia } from "../_shared/crm-nota.ts";
import { parseEtiquetas } from "../_shared/crm-tags.ts";
import {
  isBusinessHours,
  businessHoursLabel,
  type BusinessHoursConfig,
  DEFAULT_TIMEZONE,
} from "../_shared/business-hours.ts";
import { stripLoneSurrogates, truncateGraphemes } from "../_shared/text-safe.ts";
import { fetchLeadHistory } from "../_shared/history.ts";
import { createAnthropicClient } from "../_shared/anthropic-client.ts";
import { isSystemHalted, haltedResponse, logHalted } from "../_shared/halt.ts";
import { LLM_PROFILES, textOf } from "../_shared/llm.ts";
import { effortFor, modelFor } from "../_shared/models.ts";
import { evaluateClaim } from "../_shared/claim-batch.ts";
import { crmValueLeak, outboundLeak } from "../_shared/outbound.ts";
import { extractResponseBlock, detectInternalLeak, leakCorrectionMessage } from "../_shared/response-guard.ts";
import { getBudgetGate } from "../_shared/budget.ts";
import { leadsStoreInstructions, MASTER_STORE_INSTRUCTIONS } from "../_shared/memory-instructions.ts";
import { sanitizeUntrusted, turn, UNTRUSTED_NOTICE } from "../_shared/untrusted.ts";

// SUPABASE_URL and SERVICE_ROLE are injected by the Supabase runtime and
// always come from env — they are infrastructure constants, not per-client
// configuration, and are required before we can even read runtime_config.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// ---------------- search_kb tool implementation ----------------
async function runSearchKb(input: { query: string; limit?: number }) {
  // 1) Embeber el query
  const embedRes = await callInternal(supabase, "embed", { inputs: [input.query] });
  if (!embedRes.ok) {
    throw new Error(`embed: ${embedRes.status} ${await embedRes.text()}`);
  }
  const { embeddings } = (await embedRes.json()) as { embeddings: number[][] };

  // 2) Llamar a RPC search_kb
  const { data, error } = await supabase.rpc("search_kb", {
    p_query_embedding: embeddings[0],
    p_query_text: input.query,
    p_limit: Math.min(input.limit ?? 5, 12),
    p_min_similarity: 0.15,
  });
  if (error) throw new Error(`search_kb: ${error.message}`);

  const rows = (data ?? []) as Array<{
    chunk_id: string;
    document_id: string;
    document_title: string;
    content: string;
    similarity: number;
    fts_rank: number;
  }>;

  if (rows.length === 0) {
    return "Sin resultados en la KB para ese query. Asumí que la info no está documentada.";
  }

  return rows
    .map(
      (r, i) =>
        `### Resultado ${i + 1} — [${r.document_title}] (similitud ${r.similarity.toFixed(2)})\n${r.content.trim()}`
    )
    .join("\n\n---\n\n");
}

// ---------------- HTTP Tools (DB-driven, 60s TTL cache) ----------------
// Mirrors the configCache / verticalsCache pattern. Loaded BEFORE the
// EdgeRuntime.waitUntil boundary so new tools (pure DB data) work without
// any edge-function redeploy — only generate-response itself needs to be
// redeployed once when this executor code is first shipped.

type HttpToolRow = {
  name: string;
  description: string;
  http_method: string;
  url_template: string;
  headers: Array<{ name: string; value: string }>;
  body_template: unknown | null;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  timeout_ms: number;
};

let toolsCache: { items: HttpToolRow[]; loadedAt: number } | null = null;
const TOOLS_TTL_MS = 60_000;

// deno-lint-ignore no-explicit-any
async function loadHttpTools(supabaseClient: any): Promise<HttpToolRow[]> {
  if (toolsCache && Date.now() - toolsCache.loadedAt < TOOLS_TTL_MS) {
    return toolsCache.items;
  }
  const { data, error } = await supabaseClient
    .from("agent_tools")
    .select("name, description, http_method, url_template, headers, body_template, input_schema, timeout_ms")
    .eq("tool_type", "http")
    .eq("enabled", true);
  if (error) {
    console.warn("generate-response: loadHttpTools error:", error.message);
    return [];
  }
  const items = (data ?? []) as HttpToolRow[];
  toolsCache = { items, loadedAt: Date.now() };
  return items;
}

/**
 * Recursively substitutes {{param}} placeholders in a body_template value.
 * - String leaf that is EXACTLY "{{param}}" → replaced with the typed input
 *   value (preserves numbers/booleans).
 * - String leaf with embedded "{{param}}" → string interpolation.
 */
function substituteBodyTemplate(
  template: unknown,
  input: Record<string, unknown>
): unknown {
  if (typeof template === "string") {
    const exactMatch = template.match(/^\{\{(\w+)\}\}$/);
    if (exactMatch) {
      const key = exactMatch[1];
      return key in input ? input[key] : null;
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
      k in input ? String(input[k]) : ""
    );
  }
  if (Array.isArray(template)) {
    return template.map((item) => substituteBodyTemplate(item, input));
  }
  if (template !== null && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = substituteBodyTemplate(v, input);
    }
    return out;
  }
  return template;
}

/**
 * Generic HTTP tool executor. Never throws — wraps all failures in an
 * ERROR_* string so the CMA session is never crashed by a bad tool call.
 */
async function runHttpTool(
  tool: HttpToolRow,
  input: Record<string, unknown>,
  cfg: ConfigReader
): Promise<string> {
  try {
    // (a) Validate required input fields.
    for (const k of tool.input_schema.required ?? []) {
      if (!(k in input)) {
        return `ERROR_VALIDACION: falta el parámetro requerido "${k}". Esquema requeridos: ${JSON.stringify(tool.input_schema.required)}`;
      }
    }

    // (b) Substitute {{param}} in url_template (URL-encode each value).
    const url = tool.url_template.replace(/\{\{(\w+)\}\}/g, (_, p) =>
      encodeURIComponent(String(input[p] ?? ""))
    );

    // (c) Resolve {{CONFIG_KEY}} in header values via cfg.get (not from input).
    const headers: Record<string, string> = {};
    for (const h of tool.headers ?? []) {
      headers[h.name] = h.value.replace(/\{\{(\w+)\}\}/g, (_, k) =>
        cfg.get(k) ?? ""
      );
    }

    // (d) Build body for non-GET via recursive template walk.
    let body: string | undefined;
    const method = tool.http_method.toUpperCase();
    if (method !== "GET" && tool.body_template != null) {
      const substituted = substituteBodyTemplate(tool.body_template, input);
      body = JSON.stringify(substituted);
      headers["content-type"] ??= "application/json";
    }

    // (e) HTTPS-only assert.
    if (!url.startsWith("https://")) {
      return "ERROR: url_template debe ser https://";
    }

    // (e2) Una tool HTTP que apunta a una Edge Function PROPIA (p. ej. la cartelera)
    // se llama con el secreto interno, que se agrega ACÁ y no vive en agent_tools.headers:
    // esa tabla la lee cualquier usuario autenticado del panel (RLS) y el secreto
    // de las funciones internas no puede quedar a su alcance. Solo se adjunta a
    // nuestro propio origen /functions/v1/ — nunca a un host de terceros.
    if (url.startsWith(`${SUPABASE_URL}/functions/v1/`)) {
      Object.assign(headers, await internalHeaders(supabase));
    }

    // (f) AbortController with tool timeout.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), tool.timeout_ms);

    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      // (g) Cap response at 8 KB.
      const capped =
        text.length > 8192 ? truncateGraphemes(text, 8192) + "…[truncado]" : stripLoneSurrogates(text);
      return res.ok ? capped : `ERROR_HTTP ${res.status}: ${capped}`;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return `ERROR_EJECUCION: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------- CRM Tools (internas, gate por config) ----------------
// MÓDULO 3 — el agente OPERA Kommo POR NOMBRE: mover de etapa, completar campos
// del lead/contacto. Las tools están SIEMPRE declaradas (el agente sabe que
// existen) pero solo se EJECUTAN si el operador activó la capacidad (gate
// runtime en kommo_publish_config). Resolución nombre→id con caché de 60s para
// no pegarle a Kommo en cada llamada.

type CrmGate = {
  enabled: boolean; // master switch
  moveStage: boolean;
  updateLead: boolean;
  updateContact: boolean;
  addNote: boolean;
  handoff: boolean;
  tag: boolean;
};

type CrmContext = {
  kommoLeadId: number | null;
  kommoContactId: number | null;
  domain: string;
  token: string;
  gate: CrmGate;
  // Campos para registrar lead_stage_events (opcionales; fail-open si ausentes)
  internalLeadId?: string;
  currentKommoStageId?: number | null;
  currentKommoPipelineId?: number | null;
  draftId?: string;
  // De acá sale la etapa de `transferir_asesor` (HANDOFF_STAGE_NAME /
  // HANDOFF_PIPELINE_NAME en runtime_config) — NUNCA del modelo. Ver 0067.
  cfg?: ConfigReader;
};

const CRM_TOOL_NAMES = new Set([
  "mover_etapa",
  "actualizar_lead",
  "actualizar_contacto",
  "agregar_nota",
  "etiquetar_lead",
  "transferir_asesor",
]);
const CRM_TTL_MS = 60_000;
let stagesCache: { items: KommoStageLite[]; loadedAt: number } | null = null;
let leadFieldsCache: { items: KommoFieldDef[]; loadedAt: number } | null = null;
let contactFieldsCache: { items: KommoFieldDef[]; loadedAt: number } | null = null;

function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

async function getStages(domain: string, token: string): Promise<KommoStageLite[]> {
  if (stagesCache && Date.now() - stagesCache.loadedAt < CRM_TTL_MS) return stagesCache.items;
  const items = await fetchPipelineStages(domain, token);
  stagesCache = { items, loadedAt: Date.now() };
  return items;
}

async function getEntityFields(
  entity: "leads" | "contacts",
  domain: string,
  token: string
): Promise<KommoFieldDef[]> {
  const cache = entity === "leads" ? leadFieldsCache : contactFieldsCache;
  if (cache && Date.now() - cache.loadedAt < CRM_TTL_MS) return cache.items;
  const items = await fetchEntityFieldDefs(entity, domain, token);
  const entry = { items, loadedAt: Date.now() };
  if (entity === "leads") leadFieldsCache = entry;
  else contactFieldsCache = entry;
  return items;
}

/**
 * Escribe un campo de Kommo desde una tool del agente, devolviendo un mensaje
 * pensado PARA EL AGENTE.
 *
 * Los campos `select` de Kommo solo aceptan enum_id: mandarles un string
 * arbitrario devuelve 200 y no guarda nada. Antes el agente creía haber escrito
 * "Alquiler de Salas" en "Tipo de Evento" y el campo quedaba vacío para siempre.
 * Ahora, si el valor no es una opción válida, le devolvemos las opciones reales
 * para que reintente en vez de mentirle al operador.
 */
async function writeEntityField(
  entity: "leads" | "contacts",
  entityId: number,
  def: KommoFieldDef,
  value: string,
  domain: string,
  token: string
): Promise<string> {
  const etiqueta = entity === "leads" ? "lead" : "contacto";
  // Mismo verificador que el resto de la salida a Kommo (_shared/outbound.ts): un
  // residuo de tool-calling no entra a un campo del CRM, que luego puede terminar
  // en un salesbot o en la pantalla de una asesora.
  const fuga = crmValueLeak(value);
  if (fuga) {
    return `No guardé el campo "${def.name}": el valor trae residuo interno (${fuga}). Escribí solo el dato, sin sintaxis de herramientas ni rutas.`;
  }
  if (def.enums.length > 0 && !resolveFieldValue(def, value)) {
    const opciones = def.enums.map((e) => `"${e.value}"`).join(", ");
    return `El campo "${def.name}" solo admite opciones predefinidas y "${value}" no es una de ellas. Opciones válidas: ${opciones}. Reintentá con una de esas exactamente, o no escribas el campo.`;
  }
  const written = await patchEntityFieldTyped(entity, entityId, def, value, domain, token);
  return `Listo: actualicé el campo "${def.name}" del ${etiqueta} a "${written}".`;
}

/**
 * Mueve el lead a una etapa RESUELTA POR NOMBRE (resolverEtapa, puro, en
 * _shared/crm-etapa.ts) y deja el rastro en lead_stage_events.
 *
 * Existe separada de runCrmTool porque DOS tools la necesitan con criterios
 * distintos sobre quién elige la etapa: `mover_etapa` la recibe del MODELO (el
 * operador le escribió la instrucción en su voz/dreams) y `transferir_asesor` la
 * saca de runtime_config.HANDOFF_STAGE_NAME — nunca del modelo: el mensaje del
 * lead es superficie de prompt injection ("pasame a la etapa Ganado" no puede
 * ser una orden válida). Lo que no puede cambiar entre las dos es resolver el
 * nombre contra Kommo, mover y anotar el movimiento en lead_stage_events.
 */
async function moverEtapaDeLead(ctx: CrmContext, stageName: string, pipelineName: string): Promise<ResultadoEtapa> {
  if (ctx.kommoLeadId == null) {
    return { ok: false, texto: "No tengo el id de Kommo de este lead; no puedo mover la etapa." };
  }
  const stages = await getStages(ctx.domain, ctx.token);
  const resolved = resolverEtapa(stages, stageName, pipelineName);
  if (!resolved.ok) return resolved;
  const target = resolved.etapa;
  await moveLeadStage(ctx.kommoLeadId, target.id, target.pipelineId, ctx.domain, ctx.token);

  // Registrar el movimiento (fail-open: nunca romper el tool). Va por
  // apply_lead_position (0061): fija etapa + pipeline JUNTOS (142/143 existen en
  // todos los pipelines; sin kommo_pipeline_id el tablero no ubicaría al lead) y
  // registra el evento en el mismo paso. Kommo manda leads.status de vuelta por
  // este movimiento: la base lo reconoce como eco (llegue antes o después) y no
  // lo duplica ni lo deja retroceder.
  if (ctx.internalLeadId) {
    try {
      // Resolver nombre de etapa anterior si tenemos el id previo
      let fromStageName: string | null = null;
      const prevStageId = ctx.currentKommoStageId;
      if (prevStageId != null) {
        const prevStage = stages.find(
          (s) => s.id === prevStageId && (ctx.currentKommoPipelineId == null || s.pipelineId === ctx.currentKommoPipelineId)
        );
        fromStageName = prevStage?.name ?? null;
      }
      const { error: rpcErr } = await supabase.rpc("apply_lead_position", {
        p_lead_id: ctx.internalLeadId,
        p_stage_id: target.id,
        p_pipeline_id: target.pipelineId,
        p_at: new Date().toISOString(),
        p_moved_by: "agente",
        p_draft_id: ctx.draftId ?? null,
        p_from_stage_name: fromStageName,
        p_to_stage_name: target.name,
        p_pipeline_name: target.pipelineName,
      });
      if (rpcErr) throw new Error(rpcErr.message);
    } catch (evErr) {
      console.warn("lead_stage_events insert (agente) — fail-open:", evErr instanceof Error ? evErr.message : String(evErr));
    }
  }

  return { ok: true, etapa: target };
}

// Ejecuta una tool CRM por nombre. Devuelve un string para el agente (el caller
// envuelve en try/catch y manda el resultado como custom_tool_result).
async function runCrmTool(
  name: string,
  input: Record<string, unknown>,
  ctx: CrmContext
): Promise<string> {
  if (!ctx.gate.enabled) {
    return "Las acciones en el CRM están DESACTIVADAS por el operador. No realices esta acción ni se la menciones al lead.";
  }

  if (name === "mover_etapa") {
    if (!ctx.gate.moveStage) return "La acción 'mover de etapa' está desactivada por el operador. No la realices.";
    if (ctx.kommoLeadId == null) return "No tengo el id de Kommo de este lead; no puedo mover la etapa.";
    const stageName = String(input.stage_name ?? "").trim();
    if (!stageName) return "ERROR_VALIDACION: falta 'stage_name'.";
    const pipelineName = String(input.pipeline_name ?? "").trim();
    const r = await moverEtapaDeLead(ctx, stageName, pipelineName);
    if (!r.ok) return r.texto;
    return `Listo: moví el lead a la etapa "${r.etapa.name}" (pipeline "${r.etapa.pipelineName}").`;
  }

  if (name === "agregar_nota") {
    if (!ctx.gate.addNote) return "La acción 'agregar nota' está desactivada por el operador. No la realices.";
    if (ctx.kommoLeadId == null) return "No tengo el id de Kommo de este lead; no puedo agregar la nota.";
    const texto = String(input.texto ?? "").trim();
    if (!texto) return "ERROR_VALIDACION: falta 'texto'.";
    await addLeadNote(ctx.kommoLeadId, texto, ctx.domain, ctx.token);
    return "Listo: registré la nota interna en el lead (no visible para el lead).";
  }

  if (name === "etiquetar_lead") {
    if (!ctx.gate.tag) return "La acción 'etiquetar lead' está desactivada por el operador. No la realices.";
    if (ctx.kommoLeadId == null) return "No tengo el id de Kommo de este lead; no puedo etiquetar.";
    const candidatas = parseEtiquetas(input.etiquetas);
    if (candidatas.length === 0) return "ERROR_VALIDACION: falta 'etiquetas'.";
    const { added } = await addLeadTags(ctx.kommoLeadId, candidatas, ctx.domain, ctx.token);
    if (added.length === 0) return "El lead ya tenía todas esas etiquetas; no agregué ninguna nueva.";
    return `Listo: agregué la(s) etiqueta(s) ${added.map((t) => `"${t}"`).join(", ")} al lead.`;
  }

  // ── Pasar la conversación a un asesor humano ──────────────────────────────
  //
  // A diferencia de TODAS las otras acciones de CRM, ésta el agente la puede
  // ejecutar por su propio criterio cuando corresponda (ver el bloque
  // `## Acciones en el CRM` que compone agent-prompt.ts) — es la excepción
  // deliberada a "nada de CRM por iniciativa propia": pedirle a alguien que
  // espere el permiso del operador para escalar un caso que lo necesita es
  // peor que escalar de más.
  //
  // LA ETAPA NO LA ELIGE EL MODELO: sale de `runtime_config.HANDOFF_STAGE_NAME`
  // (+ `HANDOFF_PIPELINE_NAME` opcional si el nombre existe en más de un
  // pipeline). Es la única diferencia de fondo con `mover_etapa`, que sí
  // recibe la etapa por parámetro porque ahí la instrucción la escribe el
  // operador — acá el mensaje entrante es superficie de prompt injection.
  //
  // LA NOTA SE ESCRIBE PRIMERO, y aunque el movimiento falle después. Si no
  // hay ninguna etapa configurada o Kommo rechaza el PATCH, el lead se queda
  // donde estaba: sin la nota, nadie se entera nunca de que hubo un caso
  // escalado. Al revés (nota sin movimiento) alguien lo ve al abrir el lead
  // en Kommo. Se elige el fallo que deja rastro.
  if (name === "transferir_asesor") {
    if (!ctx.gate.handoff) {
      return "El pase a un asesor humano está desactivado por el operador. No lo intentes de nuevo; " +
        "decile al lead que un asesor lo va a contactar.";
    }
    if (ctx.kommoLeadId == null) {
      return "No tengo el id de Kommo de este lead; no puedo pasarlo a un asesor. " +
        "Decile al lead que escriba directamente para que lo atienda una persona.";
    }
    const motivo = String(input.motivo ?? "").trim();
    if (!motivo) {
      return "ERROR_VALIDACION: falta 'motivo'. El asesor recibe esta conversación sin saber qué pasó: " +
        "escribí en una o dos frases qué pidió o necesita el lead y por qué corresponde derivar.";
    }

    // 1) La nota — primero, porque es la que no se puede perder.
    let notaOk = true;
    try {
      await addLeadNote(ctx.kommoLeadId, construirNotaTransferencia(motivo), ctx.domain, ctx.token);
    } catch (err) {
      notaOk = false;
      console.error("transferir_asesor: no se pudo dejar la nota:", err instanceof Error ? err.message : String(err));
    }

    // 2) La etapa — si no está configurada, no se adivina ninguna: mover el
    //    lead a una etapa inventada lo esconde en un embudo donde nadie lo busca.
    const etapa = (ctx.cfg?.get("HANDOFF_STAGE_NAME") ?? "").trim();
    if (!etapa) {
      console.error("transferir_asesor: falta HANDOFF_STAGE_NAME en runtime_config.");
      return (notaOk
        ? "Dejé la nota con el motivo en el CRM, pero no hay ninguna etapa de atención humana configurada, "
        : "No pude dejar la nota ni mover el lead: no hay ninguna etapa de atención humana configurada, ") +
        "así que el lead se queda donde está. Decile que un asesor lo va a contactar y no sigas resolviendo el trámite por tu cuenta.";
    }

    let movido: ResultadoEtapa;
    try {
      movido = await moverEtapaDeLead(ctx, etapa, (ctx.cfg?.get("HANDOFF_PIPELINE_NAME") ?? "").trim());
    } catch (err) {
      console.error("transferir_asesor: falló el movimiento de etapa:", err instanceof Error ? err.message : String(err));
      movido = { ok: false, texto: "Kommo rechazó el cambio de etapa." };
    }
    if (!movido.ok) {
      console.error(`transferir_asesor: no se pudo mover a "${etapa}": ${movido.texto}`);
      return (notaOk ? "Dejé la nota con el motivo en el CRM, pero " : "No pude dejar la nota y además ") +
        "no pude mover el lead a la etapa de atención humana. " +
        "Decile al lead que un asesor lo va a contactar y no vuelvas a intentarlo: el problema es de nuestro lado.";
    }

    return `Listo: pasé la conversación a un asesor (etapa "${movido.etapa.name}")` +
      (notaOk ? " y dejé la nota con el motivo" : ", pero la nota con el motivo no se pudo guardar") +
      ". Despedite con calidez, decile que un asesor va a continuar, y no sigas resolviendo el trámite. " +
      "No prometas en cuánto tiempo le responden.";
  }


  if (name === "actualizar_lead") {
    if (!ctx.gate.updateLead) return "La acción 'actualizar datos del lead' está desactivada por el operador. No la realices.";
    if (ctx.kommoLeadId == null) return "No tengo el id de Kommo de este lead; no puedo actualizar el campo.";
    const fieldName = String(input.field_name ?? "").trim();
    const value = input.value == null ? "" : String(input.value);
    if (!fieldName) return "ERROR_VALIDACION: falta 'field_name'.";
    const fields = await getEntityFields("leads", ctx.domain, ctx.token);
    const f = fields.find((x) => norm(x.name) === norm(fieldName));
    if (!f) {
      const opciones = fields.map((x) => `"${x.name}"`).join(", ");
      return `No existe un campo de lead llamado "${fieldName}". Campos disponibles: ${opciones || "(ninguno)"}.`;
    }
    return await writeEntityField("leads", ctx.kommoLeadId, f, value, ctx.domain, ctx.token);
  }

  if (name === "actualizar_contacto") {
    if (!ctx.gate.updateContact) return "La acción 'actualizar datos del contacto' está desactivada por el operador. No la realices.";
    if (ctx.kommoContactId == null) return "Este lead no tiene un contacto asociado en Kommo; no puedo actualizar el campo.";
    const fieldName = String(input.field_name ?? "").trim();
    const value = input.value == null ? "" : String(input.value);
    if (!fieldName) return "ERROR_VALIDACION: falta 'field_name'.";
    const fields = await getEntityFields("contacts", ctx.domain, ctx.token);
    const f = fields.find((x) => norm(x.name) === norm(fieldName));
    if (!f) {
      const opciones = fields.map((x) => `"${x.name}"`).join(", ");
      return `No existe un campo de contacto llamado "${fieldName}". Campos disponibles: ${opciones || "(ninguno)"}.`;
    }
    return await writeEntityField("contacts", ctx.kommoContactId, f, value, ctx.domain, ctx.token);
  }

  return `Tool CRM desconocida: "${name}".`;
}

// Tool interna de tasa de cambio (Módulo 5). Gate simple en kommo_publish_config.
const BCV_TOOL_NAME = "tasa_bcv";

// ---------------- Debounce + batching ----------------
// Un lead suele mandar varios mensajes cortados que son una sola idea. En vez
// de responder cada uno por separado, esperamos una ventana de silencio desde
// su último mensaje y respondemos TODOS juntos en un solo draft.
const DEBOUNCE_MS = 45 * 1000;
const MAX_BATCH = 15;
// Umbral de run muerto: holgado a propósito. Hoy un run con ~18 tool calls
// tarda ~140s; con 3min de umbral el sweep podía matar runs vivos lentos.
const STALE_MS = 8 * 60 * 1000;
// Tope de invocaciones del agente en paralelo (drafts 'generating' a la vez).
// Cada invocación procesa 1 lead; cuando reclama, dispara una hermana para el
// siguiente → cascada que drena la cola en paralelo y se frena en este tope.
// 15 ≈ ~13 leads/min de capacidad sin saturar Edge/Anthropic. Subir con cuidado.
const MAX_CONCURRENT = 15;

// Fan-out concurrente: tras reclamar un lead, si quedan más esperando y no
// superamos MAX_CONCURRENT runs en vuelo, disparamos otra generate-response para
// procesar el siguiente lead EN PARALELO (ya marcamos los mensajes de este, así
// que la hermana toma otro). Best-effort: cualquier error se traga, nunca rompe
// la respuesta en curso. Solo se llama tras un reclamo exitoso → sin runaway
// (una invocación que no reclama nada retorna antes y no dispara hermanas).
async function maybeFanOut(): Promise<void> {
  try {
    const { count } = await supabase
      .from("drafts")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .contains("agent_metadata", { generating: true });
    if ((count ?? 0) >= MAX_CONCURRENT) return; // ya hay suficientes en vuelo

    const { data: more } = await supabase
      .from("messages")
      .select("id")
      .eq("direction", "inbound")
      .not("vertical_id", "is", null)
      .is("answered_by_draft_id", null)
      .eq("ignored", false)
      .eq("requires_human_review", false)
      .limit(1);
    if (!more || more.length === 0) return; // nada más que procesar

    // verify_jwt=false, pero la función exige el secreto interno (callInternal).
    const sib = callInternal(supabase, "generate-response", {}).catch(() => {});
    // @ts-ignore: EdgeRuntime existe en Supabase
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(sib);
    }
  } catch (_e) {
    // best-effort: el fan-out nunca debe romper el flujo principal.
  }
}

const MSG_SELECT =
  "id, lead_id, content, source, vertical_id, classification, requires_human_review, created_at, is_comment, verticals(slug, auto_reply, requires_review, system_prompt)";

// deno-lint-ignore no-explicit-any
type MsgRow = any;

// Devuelve el set de message_ids bloqueados por un draft "real" y borra los
// drafts pending 'generating' stale (>3min = run muerto por desconexión).
async function reclaimStaleDrafts(msgIds: string[]): Promise<Set<string>> {
  if (msgIds.length === 0) return new Set();
  const { data: existing } = await supabase
    .from("drafts")
    .select("id, message_id, status, agent_metadata, created_at")
    .in("message_id", msgIds);
  const now = Date.now();
  const blocked = new Set<string>();
  const stale: string[] = [];
  for (const d of existing ?? []) {
    const meta = (d.agent_metadata ?? {}) as Record<string, unknown>;
    if (
      d.status === "pending" &&
      meta.generating === true &&
      now - new Date(d.created_at as string).getTime() > STALE_MS
    ) {
      stale.push(d.id as string);
    } else {
      blocked.add(d.message_id as string);
    }
  }
  // Guarda status=pending: si el run terminó (approved) entre el select y el
  // delete, el delete no borra nada — evita perder una respuesta ya publicada.
  if (stale.length > 0) {
    await supabase.from("drafts").delete().in("id", stale).eq("status", "pending");
  }
  return blocked;
}

type Batch = {
  leadId: string;
  messages: MsgRow[];
  vertical: { slug: string; auto_reply: boolean; requires_review: boolean; system_prompt: string | null };
};

// Cooldown + tope por lead. cooldownSeconds=0 y maxPerLead=0 → desactivado.
type Throttle = { cooldownSeconds: number; maxPerLead: number; windowHours: number };

// Cuenta las respuestas del agente realmente enviadas/aprobadas a un lead dentro
// de la ventana, y decide si hay que silenciar este turno. Fail-open ante error
// (nunca bloquea por una falla de lectura). Una respuesta = un draft del lead en
// estado approved/publishing/sent/auto_sent (los pending no cuentan: todavía no
// salieron; `publishing` = reservado por publish-to-kommo, en pleno envío).
async function checkLeadThrottle(
  leadId: string,
  t: Throttle
): Promise<{ blocked: boolean; reason?: string }> {
  if (t.cooldownSeconds <= 0 && t.maxPerLead <= 0) return { blocked: false };
  const now = Date.now();
  const windowStart = new Date(now - t.windowHours * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("drafts")
    // Hay dos FKs entre drafts y messages (drafts.message_id y
    // messages.answered_by_draft_id): sin nombrar el FK, PostgREST responde
    // PGRST201. Acá queremos el mensaje que ORIGINÓ el draft.
    .select("created_at, status, messages!drafts_message_id_fkey!inner(lead_id)")
    .eq("messages.lead_id", leadId)
    .in("status", ["approved", "publishing", "sent", "auto_sent"])
    .gte("created_at", windowStart)
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("checkLeadThrottle error — fail-open:", error.message);
    return { blocked: false };
  }
  const rows = (data ?? []) as Array<{ created_at: string }>;
  if (t.maxPerLead > 0 && rows.length >= t.maxPerLead) {
    return {
      blocked: true,
      reason: `max_responses_per_lead (${rows.length}/${t.maxPerLead} en ${t.windowHours}h)`,
    };
  }
  if (t.cooldownSeconds > 0 && rows.length > 0) {
    const lastTs = new Date(rows[0].created_at).getTime();
    const elapsed = Math.round((now - lastTs) / 1000);
    if (elapsed < t.cooldownSeconds) {
      return { blocked: true, reason: `cooldown (${elapsed}s < ${t.cooldownSeconds}s)` };
    }
  }
  return { blocked: false };
}

async function pickLeadBatch(
  messageId?: string,
  bypass = false,
  throttle?: Throttle,
  ignoredStageIds?: number[],
  debounceMs: number = DEBOUNCE_MS,
  maxAgeHours = 0,
  // Fail-closed como toda la cadena del gate (columna default false,
  // getPublishFilters false): un caller que omita el flag NO reintroduce
  // el gasto en comentarios.
  respondToComments = false
): Promise<Batch | null> {
  // --- Camino revisión humana: responder ESE mensaje + pendientes del lead ---
  // Es un override humano explícito (botón de revisión): si alguien pide
  // responder un mensaje puntual, lo respondemos aunque estuviera "ignored"
  // (los pendientes que se le suman SÍ filtran ignored, abajo). En la práctica
  // los ignorados no aparecen en revisión, así que este caso casi no ocurre.
  if (messageId) {
    const { data: m, error } = await supabase
      .from("messages")
      .select(MSG_SELECT)
      .eq("id", messageId)
      .single();
    if (error) throw new Error(`message ${messageId}: ${error.message}`);
    const { data: pend } = await supabase
      .from("messages")
      .select(MSG_SELECT)
      .eq("lead_id", m.lead_id)
      .eq("direction", "inbound")
      .not("vertical_id", "is", null)
      .is("answered_by_draft_id", null)
      .eq("ignored", false)
      .order("created_at", { ascending: true });
    let msgs = (pend ?? []) as MsgRow[];
    if (!msgs.find((x) => x.id === m.id)) {
      msgs = [...msgs, m].sort(
        (a, b) => +new Date(a.created_at) - +new Date(b.created_at)
      );
    }
    const blocked = await reclaimStaleDrafts(msgs.map((x) => x.id));
    msgs = msgs.filter((x) => !blocked.has(x.id));
    if (msgs.length === 0) return null;
    const latest = msgs[msgs.length - 1];
    if (!latest.verticals) return null;
    return { leadId: m.lead_id, messages: msgs.slice(-MAX_BATCH), vertical: latest.verticals };
  }

  // --- Modo cola con debounce ---
  // Barrido global de runs muertos ANTES de seleccionar: un draft 'generating'
  // stale tiene su batch marcado con answered_by_draft_id, así que esos
  // mensajes son invisibles para la query de abajo y reclaimStaleDrafts nunca
  // los recibe. Borrar el draft (FK on delete set null) libera el batch y este
  // mismo barrido lo retoma. Sin esto, un run muerto = lead sin respuesta
  // para siempre.
  {
    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const { data: dead, error: sweepErr } = await supabase
      .from("drafts")
      .select("id")
      .eq("status", "pending")
      .contains("agent_metadata", { generating: true })
      .lt("created_at", cutoff);
    if (sweepErr) {
      console.warn("sweep select:", sweepErr.message);
    } else if (dead && dead.length > 0) {
      // Guarda status=pending también en el delete: si un run lento terminó
      // (approved) entre el select y acá, no se borra su respuesta.
      const { error: delErr } = await supabase
        .from("drafts")
        .delete()
        .in("id", dead.map((d) => d.id))
        .eq("status", "pending");
      if (delErr) console.warn("sweep delete:", delErr.message);
      else console.warn(`sweep: ${dead.length} draft(s) generating stale — batches liberados`);
    }
  }

  // Con bypass, también tomamos los mensajes en review humana (el agente
  // responde y publica todo). Sin bypass, solo los no marcados.
  let q = supabase
    .from("messages")
    .select(MSG_SELECT)
    .eq("direction", "inbound")
    .not("vertical_id", "is", null)
    .is("answered_by_draft_id", null)
    .eq("ignored", false);
  if (!bypass) q = q.eq("requires_human_review", false);
  // Ventana de frescura: solo atender mensajes recientes. Lo más viejo que la
  // ventana NO se responde (lo manejan los asesores) → no arrastra backlog.
  if (maxAgeHours > 0) {
    const freshCutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
    q = q.gte("created_at", freshCutoff);
  }
  const { data, error } = await q
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`pick: ${error.message}`);
  if (!data || data.length === 0) return null;

  const blocked = await reclaimStaleDrafts(data.map((m: MsgRow) => m.id));
  const candidates = (data as MsgRow[]).filter((m) => !blocked.has(m.id));
  if (candidates.length === 0) return null;

  const byLead = new Map<string, MsgRow[]>();
  for (const m of candidates) {
    if (!byLead.has(m.lead_id)) byLead.set(m.lead_id, []);
    byLead.get(m.lead_id)!.push(m);
  }
  // Priorizar leads CALIENTES: el que escribió más recientemente, primero. Así
  // un comprador nuevo no espera detrás de conversaciones más viejas. La ventana
  // de frescura ya acota la cola, así que esto solo reordena dentro de lo fresco
  // (cada array de mensajes viene en orden ascendente → el último es el más nuevo).
  const newestTs = (msgs: MsgRow[]) => +new Date(msgs[msgs.length - 1].created_at as string);
  const leadsOrdered = [...byLead.entries()].sort(
    (a, b) => newestTs(b[1]) - newestTs(a[1])
  );

  const now = Date.now();
  for (const [leadId, msgsAll] of leadsOrdered) {
    let msgs = msgsAll;
    // Comentarios apagados (respond_to_comments=false): los mensajes nacidos
    // de un comentario no se responden. Red de seguridad autoritativa — el
    // gate primario (cero tokens) está en process-inbound; este cubre el
    // backlog pre-gate y las carreras de detección. Se marcan ignored para
    // que los barridos no los re-evalúen; los DMs del mismo lead siguen.
    if (!respondToComments) {
      const commentIds = msgs.filter((m) => m.is_comment === true).map((m) => m.id);
      if (commentIds.length > 0) {
        await supabase
          .from("messages")
          .update({ ignored: true, ignored_reason: "comments_off" })
          .in("id", commentIds);
        msgs = msgs.filter((m) => m.is_comment !== true);
        if (msgs.length === 0) continue;
      }
    }
    // Debounce: el último inbound del lead (cualquiera) debe ser más viejo
    // que la ventana — si no, el lead todavía está escribiendo, esperamos.
    const { data: lastIn } = await supabase
      .from("messages")
      .select("created_at")
      .eq("lead_id", leadId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastTs = lastIn ? new Date(lastIn.created_at as string).getTime() : 0;
    if (now - lastTs < debounceMs) continue;
    // Etapa ignorada: si el lead está en una etapa silenciada de Kommo, el
    // agente no atiende. Stage null = atiende (igual que el gate de follow-up).
    if (ignoredStageIds && ignoredStageIds.length > 0) {
      const { data: ld } = await supabase
        .from("leads")
        .select("kommo_stage_id")
        .eq("id", leadId)
        .maybeSingle();
      const stage = ld?.kommo_stage_id;
      if (stage != null && ignoredStageIds.includes(Number(stage))) continue;
    }
    // Cooldown / tope por lead: si este lead está silenciado, lo SALTAMOS y
    // seguimos con el próximo (no cortamos la cola — eso mataría de hambre a los
    // demás leads). Sus mensajes quedan sin contestar y el sweep los retoma
    // cuando pase la ventana.
    if (throttle) {
      const gate = await checkLeadThrottle(leadId, throttle);
      if (gate.blocked) continue;
    }
    const latest = msgs[msgs.length - 1];
    if (!latest.verticals) continue;
    return { leadId, messages: msgs.slice(-MAX_BATCH), vertical: latest.verticals };
  }
  return null;
}

// ---------------- Lead info ----------------
async function getLead(leadId: string) {
  const { data, error } = await supabase
    .from("leads")
    .select("id, kommo_lead_id, kommo_contact_id, display_name, channel, kommo_stage_id, kommo_pipeline_id")
    .eq("id", leadId)
    .single();
  if (error) throw new Error(`lead ${leadId}: ${error.message}`);
  return data;
}

// Fecha y hora actual en la zona horaria del operador, en español. El modelo
// tiene knowledge cutoff y no sabe "hoy": se la inyectamos en cada sesión.
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

// ---------------- Helpers de promociones/eventos ----------------
type PromoRow = {
  name: string; content: string; kind: "promo" | "evento";
  starts_at: string | null; ends_at: string | null; weekdays: number[] | null;
};

// Fecha local YYYY-MM-DD + isodow en el TZ (mismo motor que business-hours.ts).
function localDateParts(timezone: string): { ymd: string; isodow: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`; // en-CA → ISO
  const isodow = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[get("weekday")] ?? 0;
  return { ymd, isodow };
}

// ends_at INCLUSIVE; weekdays ANY; sin rango/sin weekdays = no restringe.
function isPromotionActiveToday(p: PromoRow, today: { ymd: string; isodow: number }): boolean {
  if (p.starts_at && today.ymd < p.starts_at) return false;
  if (p.ends_at && today.ymd > p.ends_at) return false;          // inclusive
  if (p.weekdays && p.weekdays.length > 0 && !p.weekdays.includes(today.isodow)) return false;
  return true;
}

// Evento que empieza en (hoy, hoy+7]: próximo, no activo aún.
function isUpcomingEvent(p: PromoRow, today: { ymd: string }): boolean {
  if (p.kind !== "evento" || !p.starts_at) return false;
  if (p.starts_at <= today.ymd) return false;                    // ya empezó → lo maneja activeToday
  const limit = new Date(today.ymd + "T00:00:00Z");
  limit.setUTCDate(limit.getUTCDate() + 7);
  return p.starts_at <= limit.toISOString().slice(0, 10);
}

const PROMO_CAP = 8;
const PROMO_TRUNC = 250;
function truncate(s: string, n: number) { return truncateGraphemes(s, n, { ellipsis: "…" }); }

function buildPromoContext(rows: PromoRow[], timezone: string): {
  activePromos: string | null; upcomingEvents: string | null;
} {
  const today = localDateParts(timezone);
  const active = rows.filter((p) => isPromotionActiveToday(p, today)).slice(0, PROMO_CAP)
    .map((p) => `- ${p.name}: ${truncate(p.content, PROMO_TRUNC)}`);
  const upcoming = rows.filter((p) => isUpcomingEvent(p, today)).slice(0, PROMO_CAP)
    .map((p) => `- ${p.name} (desde ${p.starts_at}): ${truncate(p.content, PROMO_TRUNC)}`);
  return {
    activePromos: active.length ? active.join("\n") : null,
    upcomingEvents: upcoming.length ? upcoming.join("\n") : null,
  };
}

// ---------------- Helpers de situaciones (contexto ambiental) ----------------
// A diferencia de las promos ("mencionar solo si viene al caso"), las situaciones
// son contexto vigente que el agente SIEMPRE debe tener en cuenta (un feriado, un
// corte de luz, una emergencia). Mismo motor de fechas (ends_at INCLUSIVE).
type SituationRow = { title: string; content: string; starts_at: string | null; ends_at: string | null };

function isSituationActiveToday(s: SituationRow, today: { ymd: string }): boolean {
  if (s.starts_at && today.ymd < s.starts_at) return false;
  if (s.ends_at && today.ymd > s.ends_at) return false; // inclusive
  return true;
}

function buildSituationContext(rows: SituationRow[], timezone: string): string | null {
  const today = localDateParts(timezone);
  const active = rows
    .filter((s) => isSituationActiveToday(s, today))
    .slice(0, PROMO_CAP)
    .map((s) => `- ${s.title}: ${truncate(s.content, PROMO_TRUNC)}`);
  return active.length ? active.join("\n") : null;
}

// ---------------- Guardarraíl: concurso de IG + número de asesora ----------------
// Incidente real (lead a40b68d6, 25-ago-2026): un participante de una dinámica
// de Instagram ("Logradoo iría con mi familia 🥳") fue mal clasificado como
// interés real en evento corporativo, y el agente terminó compartiéndole el
// WhatsApp real de una asesora. Esta red de seguridad no depende de que el
// clasificador acierte: si el batch tiene marca de concurso Y el texto generado
// contiene un teléfono, se fuerza revisión humana en vez de auto-enviar.
const CONTEST_MARKER_RE = /\blogrado\b/i;
const VE_PHONE_RE = /(?:\+?58[\s-]?)?0?4\d{2}[\s-]?\d{3}[\s-]?\d{4}/;

function batchHasContestMarker(msgs: MsgRow[]): boolean {
  return msgs.some((m) => CONTEST_MARKER_RE.test(String(m.content ?? "")));
}

// ---------------- Construir contexto user.message ----------------
function buildContext(opts: {
  lead: { id: string; display_name: string | null; channel: string | null };
  messages: Array<{ content: string; created_at: string }>;
  history: string;
  verticalSlug: string;
  verticalPrompt: string | null;
  channel: string | null;
  classification: Record<string, unknown> | null;
  masterPath: string;
  leadsPath: string;
  now: string;
  timezone: string;
  businessHours: { active: boolean; label: string };
  activePromos: string | null;
  upcomingEvents: string | null;
  situaciones: string | null;
  commentInstructions?: string | null;
  // Digest de aprendizajes (dreams) consolidado por dreams-run en
  // runtime_config.DREAMS_DIGEST. Reemplaza la lectura de /dreams/ por
  // filesystem en cada sesión (231 archivos llegaron a costar listados +
  // lecturas + turnos extra POR RESPUESTA en KIA).
  dreamsDigest?: string | null;
}) {
  const cls = opts.classification ?? {};
  const multi = opts.messages.length > 1;
  // Fecha+hora completa (no solo HH:MM) en todos los casos, incluido el mensaje
  // único: sin esto el agente no tiene forma de saber que está respondiendo un
  // mensaje de hace varios días (ej. tras una recuperación de backlog) y no
  // puede aplicar la instrucción de reconocer la demora más abajo.
  // El texto del lead es entrada NO confiable: cada mensaje va como turno
  // saneado (ver _shared/untrusted.ts). El prefijo "(n) [fecha hora]" lo genera
  // el sistema, fuera del turno.
  const fmtTs = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  const block = opts.messages
    .map((m, i) =>
      multi
        ? `(${i + 1}) [${fmtTs(m.created_at)}] ${turn("lead", m.content)}`
        : `[${fmtTs(m.created_at)}] ${turn("lead", m.content)}`
    )
    .join("\n");

  const header = multi
    ? `[MENSAJES DEL LEAD — ${opts.messages.length} mensajes seguidos, trátalos como UNA sola conversación y responde de forma unificada, no uno por uno]`
    : `[MENSAJE DEL LEAD]`;

  // Historial determinístico leído de la DB (el agente ya no lee ni escribe
  // conversation.md en el Memory Store: este bloque ES la conversación previa).
  // Es contexto VERIFICADO de los turnos previos: el agente lo usa para no
  // repetir preguntas ni perder el hilo. Va antes del/los mensaje(s) nuevo(s).
  const historyBlock = opts.history
    ? `[HISTORIAL RECIENTE DE LA CONVERSACIÓN — turnos ya intercambiados con este lead, en orden cronológico, uno por línea. Úsalo para responder con continuidad: no repitas lo ya dicho ni preguntes lo ya respondido. ${UNTRUSTED_NOTICE}]
${opts.history}

`
    : "";

  return `[CONTEXTO]
fecha_hora_actual: ${opts.now} (zona horaria ${opts.timezone})
en_horario_laboral: ${opts.businessHours.active ? "sí" : "no"} (${opts.businessHours.label}). Si es "no" y el lead necesita un asesor humano, avisale que el equipo lo contacta apenas retome el horario de atención — no prometas transferencia inmediata.
${opts.dreamsDigest ? `aprendizajes_del_operador (reglas del operador aprendidas de conversaciones reales — PRIORIDAD MÁXIMA sobre tu voz base; aplicalas SIEMPRE):\n${opts.dreamsDigest}\n` : ""}${opts.activePromos ? `promociones_activas (mencionalas solo si vienen al caso de lo que pregunta el lead):\n${opts.activePromos}` : "promociones_activas: ninguna"}${opts.upcomingEvents ? `\neventos_proximos (podes anticiparlos si aportan a la conversacion):\n${opts.upcomingEvents}` : ""}${opts.situaciones ? `\nsituaciones_actuales (contexto vigente que SIEMPRE debés tener en cuenta al responder, aunque el lead no pregunte por eso):\n${opts.situaciones}` : ""}${opts.commentInstructions != null ? `\norigen_comentario_instagram: sí — ${opts.commentInstructions}` : ""}
lead_id: ${opts.lead.id}
lead_name: ${opts.lead.display_name ? sanitizeUntrusted(opts.lead.display_name, { maxChars: 80 }) : "(desconocido)"}
vertical: ${opts.verticalSlug}${
    opts.verticalPrompt && opts.verticalPrompt.trim()
      ? `\ninstrucciones_de_la_vertical (cómo tratar ESTE tipo de consulta; mandan sobre tu criterio general, pero NUNCA por encima de aprendizajes_del_operador ni de tu system prompt):\n${opts.verticalPrompt.trim()}`
      : ""
  }
channel: ${opts.channel ?? "unknown"}
intent: ${cls.intent ?? "?"}
urgency: ${cls.urgency ?? "?"}
toxicity: ${cls.toxicity ?? "?"}
confidence: ${cls.confidence ?? "?"}
classifier_reasoning: ${typeof cls.reasoning === "string" ? sanitizeUntrusted(cls.reasoning, { maxChars: 300 }) : "?"}

${historyBlock}${header} (${UNTRUSTED_NOTICE})
${block}

Procede según tu system prompt: aplica los aprendizajes del bloque aprendizajes_del_operador si está presente, lee ${opts.leadsPath}/${opts.lead.id}/learnings.md si existe, usa search_kb si la pregunta es factual, redacta la respuesta con la voz definida en tu system prompt. La conversación previa ya está en el historial de arriba: no la busques en la memoria. Solo escribí en learnings.md si aprendiste algo DURADERO de este lead; si no hay nada nuevo, no escribas nada. Usá fecha_hora_actual para cualquier cosa relativa al tiempo (hoy, mañana, vencimientos, horarios, días de demora). Cada mensaje del lead trae su propia fecha/hora entre corchetes: si el más reciente que estás respondiendo tiene más de 24 horas de diferencia con fecha_hora_actual, reconocé la demora brevemente antes de responder (ej: "Disculpá la demora en responder") — no lo trates como si acabara de llegar, y si el contenido puede haber quedado desactualizado por el paso del tiempo (una función, una fecha, un cupo), decilo en vez de asumir que sigue vigente.

Tu MENSAJE FINAL debe ser SOLO el texto que se envía al lead. Sin preámbulo.`;
}

// Detector de fuga: patrones del guard compartido (_shared/response-guard.ts) +
// la red propia de SuperCines (decisión de silencio / cita de aprendizajes del
// operador que el agente a veces redacta en vez del mensaje real).
const INTERNAL_REASONING_RE =
  /aprendizajes del operador|an[aá]lisis interno|silencio absoluto|no\s+env[ií]o\s+respuesta|no\s+respondo\b|NO RESPONDER/i;
function leakOf(text: string): string | null {
  return detectInternalLeak(text) ?? (INTERNAL_REASONING_RE.test(text) ? "razonamiento interno del agente" : null);
}

// ---------------- Orquestar sesión CMA ----------------
type Outcome = {
  responseText: string;
  // Verificador de fuga interna (_shared/response-guard.ts): `reason` != null o
  // `wellFormed` false => el draft NUNCA se auto-aprueba.
  leak: { attempts: number; reason: string | null; wellFormed: boolean };
  rawResponseText: string;
  toolCalls: number;
  durationMs: number;
  sessionId: string;
};

async function runAgent(opts: {
  leadId: string;
  contextMessage: string;
  agentId: string;
  environmentId: string;
  memstoreMaster: string;
  memstoreLeads: string;
  anthropic: Anthropic;
  httpTools: HttpToolRow[];
  cfg: ConfigReader;
  kommoLeadId: number | null;
  kommoContactId: number | null;
  crm: CrmGate;
  bcvEnabled: boolean;
  // Campos para registrar lead_stage_events cuando el agente mueve etapas
  currentKommoStageId?: number | null;
  currentKommoPipelineId?: number | null;
  draftId?: string;
}): Promise<Outcome> {
  const start = Date.now();

  // 1) Crear sesión con ambos memory stores
  const session = await opts.anthropic.beta.sessions.create({
    agent: opts.agentId,
    environment_id: opts.environmentId,
    title: `respond ${opts.leadId.slice(0, 8)} ${new Date().toISOString()}`,
    resources: [
      {
        type: "memory_store",
        memory_store_id: opts.memstoreMaster,
        access: "read_only",
        instructions: MASTER_STORE_INSTRUCTIONS,
      },
      {
        type: "memory_store",
        memory_store_id: opts.memstoreLeads,
        access: "read_write",
        // El historial viaja en el [CONTEXTO] (fetchLeadHistory): el agente no lee ni
        // reescribe conversation.md; solo learnings.md, y solo si hay algo duradero.
        instructions: leadsStoreInstructions(opts.leadId),
      },
    ],
  });

  // 2) Abrir stream PRIMERO, después enviar mensaje
  const [, , stream] = await Promise.all([
    Promise.resolve(),
    Promise.resolve(),
    opts.anthropic.beta.sessions.events.stream(session.id),
  ]);

  await opts.anthropic.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: opts.contextMessage }],
      },
    ],
  });

  // 3) Loop de eventos
  let responseText = "";
  let toolCalls = 0;

  // VERIFICADOR DE FUGA INTERNA: reprocesa en la MISMA sesión (reusa contexto y
  // memoria) cuando el bloque <respuesta> viene malformado o el texto trae
  // residuo de razonamiento/tool-calling. Acotado; si tras los reintentos sigue
  // mal, el caller fuerza revisión humana.
  const MAX_LEAK_RETRIES = 2;
  let leakAttempts = 0;
  let leakReason: string | null = null;

  for await (const event of stream) {
    // deno-lint-ignore no-explicit-any
    const ev = event as any;
    if (ev.type === "agent.message") {
      // Reset: nos quedamos con el ÚLTIMO agent.message
      // (mensajes intermedios suelen ser razonamiento previo a tool calls)
      responseText = "";
      for (const block of ev.content ?? []) {
        if (block.type === "text") responseText += block.text;
      }
    } else if (ev.type === "agent.custom_tool_use") {
      toolCalls++;
      try {
        let result: string;
        if (ev.name === "search_kb") {
          result = await runSearchKb(ev.input ?? {});
        } else if (CRM_TOOL_NAMES.has(ev.name)) {
          // Tools internas que operan Kommo (mover_etapa / actualizar_lead /
          // actualizar_contacto). Gate de seguridad por config (runtime).
          const domain = opts.cfg.get("KOMMO_API_DOMAIN");
          const token = opts.cfg.get("KOMMO_ACCESS_TOKEN");
          result = !domain || !token
            ? "Kommo no está conectado; no puedo operar el CRM."
            : await runCrmTool(ev.name, ev.input ?? {}, {
                kommoLeadId: opts.kommoLeadId,
                kommoContactId: opts.kommoContactId,
                domain,
                token,
                gate: opts.crm,
                internalLeadId: opts.leadId,
                currentKommoStageId: opts.currentKommoStageId,
                currentKommoPipelineId: opts.currentKommoPipelineId,
                draftId: opts.draftId,
                // Solo lo usa `transferir_asesor`, para leer HANDOFF_STAGE_NAME /
                // HANDOFF_PIPELINE_NAME — la etapa NO la elige el modelo.
                cfg: opts.cfg,
              });
        } else if (ev.name === BCV_TOOL_NAME) {
          // Tasa USD→VES (BCV). Gate por config; cache 6h en _shared/exchange.
          if (!opts.bcvEnabled) {
            result = "La consulta de tasa de cambio está desactivada por el operador. No la realices ni menciones que existe.";
          } else {
            try {
              const r = await getBcvRate(opts.cfg);
              result = `Tasa oficial BCV vigente: 1 USD = ${r.rate} Bs (fuente: ${r.source}, obtenida: ${r.fetchedAt}). Usala como referencia aproximada del día; el monto exacto en bolívares lo confirma el operador al cobrar.`;
            } catch (err) {
              // El detalle (status HTTP, fuente custom) va al log, NO al agente:
              // el tool result puede terminar relayado textual al cliente final.
              console.error("tasa_bcv:", err instanceof Error ? err.message : err);
              result =
                "No pude obtener la tasa de cambio en este momento. Decile al cliente que el monto en bolívares se confirma al coordinar el pago.";
            }
          }
        } else {
          // Generic HTTP tool executor: look up by name in the 60s-TTL cache.
          // Completely DB-driven — no per-tool code, no hardcoded names here.
          const tool = opts.httpTools.find((t) => t.name === ev.name);
          result = tool
            ? await runHttpTool(tool, ev.input ?? {}, opts.cfg)
            : `Tool desconocida: "${ev.name}". La tool no está registrada o está deshabilitada.`;
        }
        await opts.anthropic.beta.sessions.events.send(session.id, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: ev.id,
              content: [{ type: "text", text: result }],
            },
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await opts.anthropic.beta.sessions.events.send(session.id, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: ev.id,
              content: [{ type: "text", text: `ERROR: ${msg}` }],
              is_error: true,
            },
          ],
        });
      }
    } else if (ev.type === "session.status_idle") {
      const stop = ev.stop_reason?.type;
      if (stop === "requires_action") continue; // aún faltan resultados de tools
      // Cualquier idle que no sea un cierre normal queda en el log (cortes por
      // max_tokens, refusals): sin turno completo no hay respuesta que publicar.
      if (stop && stop !== "end_turn") {
        console.warn(`generate-response: sesión ${session.id} quedó idle con stop_reason=${stop} (draft ${opts.draftId ?? "?"})`);
      }

      // VERIFICADOR DE FUGA INTERNA — el agente terminó el turno. Si el bloque
      // <respuesta>...</respuesta> no cierra bien, o el texto extraído trae
      // residuo que nunca debe llegar al cliente, se pide el formato correcto
      // en la misma sesión, hasta MAX_LEAK_RETRIES veces.
      const extracted = extractResponseBlock(responseText);
      leakReason = !extracted.wellFormed
        ? "el bloque <respuesta>...</respuesta> vino malformado o ausente"
        : leakOf(extracted.text);
      if (leakReason && leakAttempts < MAX_LEAK_RETRIES) {
        leakAttempts++;
        console.warn(
          `generate-response: VERIFICADOR fuga (intento ${leakAttempts}/${MAX_LEAK_RETRIES}) draft ${opts.draftId ?? "?"}: ${leakReason} → reprocesando en sesión`
        );
        await opts.anthropic.beta.sessions.events.send(session.id, {
          events: [
            { type: "user.message", content: [{ type: "text", text: leakCorrectionMessage(leakReason) }] },
          ],
        });
        continue;
      }
      break;
    } else if (ev.type === "session.status_terminated") {
      break;
    } else if (ev.type === "session.error") {
      const msg = ev.error?.message ?? "session error";
      throw new Error(msg);
    }
  }

  // Extraer SOLO lo que está dentro de <respuesta>...</respuesta>. NO hay
  // fallback al texto crudo (filtró razonamiento interno al cliente 171 veces en
  // producción): si el bloque no cierra bien, extractResponseBlock marca
  // wellFormed=false y el llamador está obligado a forzar revisión humana en vez
  // de auto-enviar.
  const extractedFinal = extractResponseBlock(responseText);
  const clean = extractedFinal.text;
  if (!extractedFinal.wellFormed) {
    leakReason = leakReason ?? "el bloque <respuesta>...</respuesta> vino malformado o ausente";
    console.error(
      `generate-response: VERIFICADOR fuga — bloque malformado tras ${leakAttempts} reintento(s) (draft ${opts.draftId ?? "?"}) → NO se auto-envía`
    );
  }
  // Chequeo final sobre el texto que efectivamente se devuelve, por si el turno
  // que rompió el loop (p. ej. session.status_terminated) no pasó por el de arriba.
  leakReason = leakReason ?? leakOf(clean);

  return {
    responseText: clean,
    rawResponseText: responseText.trim(),
    leak: { attempts: leakAttempts, reason: leakReason, wellFormed: extractedFinal.wellFormed },
    toolCalls,
    durationMs: Date.now() - start,
    sessionId: session.id,
  };
}

// ---------------- Entry point ----------------
Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("generate-response OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  // Gate interno: esta función NO es un webhook público (ver _shared/auth.ts).
  {
    const denied = await authorizeInternal(req, supabase);
    if (denied) return denied;
  }

  // Apagado total: query aparte (isSystemHalted, cacheada 60s) en vez de
  // sumarse al select de `cfg` de abajo — así un deploy de esta función antes
  // de aplicar la migración 0057 no rompe ese select por pedir una columna
  // que todavía no existe (fail-open, ver _shared/halt.ts). Se chequea antes
  // de parsear el body: ni eso vale la pena si el sistema está apagado.
  if (await isSystemHalted(supabase)) {
    logHalted("generate-response");
    return haltedResponse({ picked: null });
  }

  let body: { message_id?: string; force_review?: boolean } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    // ignore
  }
  const forceReview = body.force_review === true;

  // Kill switch: si el agente está deshabilitado en config, no genera nada.
  // (publishing_enabled se controla aparte en publish-to-kommo.)
  const { data: cfg } = await supabase
    .from("kommo_publish_config")
    .select(
      "agent_enabled, bypass_review, publishing_enabled, response_cooldown_seconds, max_responses_per_lead, cooldown_window_hours, ignored_stage_ids, response_debounce_seconds, answer_max_age_hours, crm_actions_enabled, crm_can_move_stage, crm_can_update_lead, crm_can_update_contact, bcv_rate_enabled, comment_instructions, comment_reply_enabled, comment_reply_rules, respond_to_comments"
    )
    .eq("is_active", true)
    .maybeSingle();

  // Zona horaria + horario laboral del operador (follow_up_config es la single
  // source of truth: la edita /agent y la consume también follow-up-scan).
  const { data: fuCfg } = await supabase
    .from("follow_up_config")
    .select("timezone, business_hours, business_hours_start, business_hours_end, active_days")
    .eq("is_active", true)
    .maybeSingle();
  const timezone = (fuCfg?.timezone as string) || DEFAULT_TIMEZONE;
  const bizCfg: BusinessHoursConfig = {
    timezone,
    business_hours: (fuCfg?.business_hours as BusinessHoursConfig["business_hours"]) ?? null,
    business_hours_start: Number(fuCfg?.business_hours_start ?? 9),
    business_hours_end: Number(fuCfg?.business_hours_end ?? 20),
    active_days: ((fuCfg?.active_days as number[] | null) ?? [1, 2, 3, 4, 5, 6]).map(Number),
  };

  if (cfg && cfg.agent_enabled === false) {
    return new Response(
      JSON.stringify({ ok: true, picked: null, skipped: "agent disabled" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  // Techo de gasto mensual (>=100%): no genera respuestas nuevas. No aplica a
  // forceReview: un humano pidiendo un borrador puntual desde el inbox no debe
  // quedar bloqueado por el gate agregado. Ausente/"0" en MONTHLY_BUDGET_USD =
  // sin freno (getBudgetGate es fail-open, ver _shared/budget.ts).
  if (!forceReview) {
    const budget = await getBudgetGate(supabase, await loadConfig(supabase));
    if (budget.blockGenerate) {
      return new Response(
        JSON.stringify({ ok: true, picked: null, skipped: "budget exceeded", pct: budget.pct }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  }

  // Bypass de review: solo tiene efecto si publishing está habilitado.
  // No aplica al camino de revisión humana explícita (forceReview).
  const bypass =
    !forceReview &&
    cfg?.bypass_review === true &&
    cfg?.publishing_enabled === true;

  // Cooldown / tope por lead (no aplica al camino de revisión humana explícita).
  const throttle: Throttle | undefined = forceReview
    ? undefined
    : {
        cooldownSeconds: Number(cfg?.response_cooldown_seconds ?? 0) || 0,
        maxPerLead: Number(cfg?.max_responses_per_lead ?? 0) || 0,
        windowHours: Number(cfg?.cooldown_window_hours ?? 24) || 24,
      };

  // Etapas ignoradas (tampoco aplica a revisión humana explícita).
  const ignoredStageIds: number[] | undefined = forceReview
    ? undefined
    : (((cfg?.ignored_stage_ids ?? []) as unknown[]).map(Number).filter((n) => Number.isFinite(n)));

  // Gate maestro de comentarios (0048). Default OFF: los comentarios no se
  // responden (ni DM ni público). comment_reply_enabled solo suma la
  // respuesta pública cuando este gate está ON.
  const respondToComments = cfg?.respond_to_comments === true;

  // Debounce configurable: segundos de silencio a esperar antes de responder el
  // batch. Default 45s. No aplica al camino de revisión humana explícita.
  const debounceMs = forceReview
    ? 0
    : Math.max(0, Number(cfg?.response_debounce_seconds ?? 45)) * 1000;

  // Ventana de frescura: el agente solo atiende mensajes de las últimas N horas
  // (lo más viejo lo manejan los asesores). Default 1h. No aplica a revisión
  // humana explícita (esa responde el mensaje pedido sin importar su antigüedad).
  const maxAgeHours = forceReview ? 0 : Math.max(0, Number(cfg?.answer_max_age_hours ?? 1));

  // Gates de las 3 acciones extra (0067), en consulta APARTE: si la migración
  // todavía no se aplicó, este select falla solo y las acciones quedan OFF sin
  // tumbar el select grande de arriba (fail-closed para acciones sobre el CRM).
  const { data: crmExtra } = await supabase
    .from("kommo_publish_config")
    .select("crm_can_add_note, crm_can_handoff, crm_can_tag")
    .eq("is_active", true)
    .maybeSingle();

  // Gate de las acciones de CRM (Módulo 3). Default OFF: el agente no toca el
  // CRM hasta que el operador active master + la capacidad puntual.
  const crm: CrmGate = {
    enabled: cfg?.crm_actions_enabled === true,
    moveStage: cfg?.crm_can_move_stage === true,
    updateLead: cfg?.crm_can_update_lead === true,
    updateContact: cfg?.crm_can_update_contact === true,
    addNote: crmExtra?.crm_can_add_note === true,
    handoff: crmExtra?.crm_can_handoff === true,
    tag: crmExtra?.crm_can_tag === true,
  };


  const batch = await pickLeadBatch(body.message_id, bypass, throttle, ignoredStageIds, debounceMs, maxAgeHours, respondToComments);
  if (!batch) {
    return new Response(JSON.stringify({ ok: true, picked: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const vertical = batch.vertical;
  const batchMsgs = batch.messages as MsgRow[];
  const latestMsg = batchMsgs[batchMsgs.length - 1];
  const batchIds = batchMsgs.map((m) => m.id as string);

  // Un solo draft por batch, anclado al mensaje MÁS RECIENTE del lead.
  const { data: draft, error: draftErr } = await supabase
    .from("drafts")
    .insert({
      message_id: latestMsg.id,
      body: "",
      status: "pending",
      agent_metadata: { generating: true, batch_size: batchMsgs.length },
    })
    .select("id")
    .single();
  if (draftErr || !draft) {
    return new Response(
      JSON.stringify({ ok: false, error: `draft insert: ${draftErr?.message}` }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  // CLAIM ATÓMICO del batch (RPC claim_message_batch, migración 0064): marca
  // TODOS los mensajes como cubiertos por este draft en UNA sentencia. El
  // SELECT-y-después-UPDATE anterior dejaba que dos invocaciones concurrentes
  // (webhook, sweep de pg_cron, process-inbound, fan-out) eligieran el MISMO
  // lead y respondieran dos veces (en KIA: 247 respuestas dobles ENVIADAS en
  // un día). Si el draft se borra por stale, el FK on delete set null libera
  // el batch y se reprocesa. evaluateClaim (puro) interpreta el resultado.
  const { data: claimedCount, error: claimErr } = await supabase.rpc("claim_message_batch", {
    p_message_ids: batchIds,
    p_draft_id: draft.id,
  });
  const claim = evaluateClaim(claimedCount, claimErr, batchIds.length);
  if (!claim.won) {
    // Soltar lo tomado a medias ANTES de borrar el draft: si no, el batch queda
    // huérfano.
    if (claim.needsRelease) {
      await supabase.from("messages").update({ answered_by_draft_id: null }).eq("answered_by_draft_id", draft.id);
    }
    // Solo si sigue pending: nunca borrar un draft ya publicado.
    await supabase.from("drafts").delete().eq("id", draft.id).eq("status", "pending");
    console.log(claim.message);
    // ok:true a propósito: perder el claim bajo concurrencia es el camino
    // NORMAL (otra invocación ya responde este lote), no una falla.
    return new Response(
      JSON.stringify({ ok: true, skipped: "batch_claimed_by_other_run" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  // Ya reclamamos este lead → disparamos una hermana para el siguiente, en
  // paralelo (hasta MAX_CONCURRENT). Así una ráfaga de leads se atiende junta
  // en vez de de a uno por minuto. Best-effort: no bloquea ni rompe nada.
  await maybeFanOut();

  // CRITICAL: resolve ALL config values BEFORE EdgeRuntime.waitUntil(slowWork).
  // After waitUntil the client has disconnected; any async I/O failure here
  // would leave the draft stuck 'pending'. Resolving before the boundary means
  // a config error surfaces synchronously and the draft can be cleaned up.
  let agentId!: string, environmentId!: string, memstoreMaster!: string, memstoreLeads!: string;
  let masterPath!: string, leadsPath!: string, anthropic!: Anthropic;
  let httpTools: HttpToolRow[] = [];
  let resolvedCfg!: ConfigReader;
  try {
    const runtimeCfg = await loadConfig(supabase);
    resolvedCfg = runtimeCfg;
    agentId = runtimeCfg.require("ANTHROPIC_AGENT_ID");
    environmentId = runtimeCfg.require("ANTHROPIC_ENVIRONMENT_ID");
    memstoreMaster = runtimeCfg.require("ANTHROPIC_MEMORY_MASTER_ID");
    memstoreLeads = runtimeCfg.require("ANTHROPIC_MEMORY_LEADS_ID");
    const masterStoreName = runtimeCfg.getOr("MEMORY_STORE_MASTER_NAME", "master");
    const leadsStoreName = runtimeCfg.getOr("MEMORY_STORE_LEADS_NAME", "leads");
    masterPath = `/mnt/memory/${masterStoreName}`;
    leadsPath = `/mnt/memory/${leadsStoreName}`;
    anthropic = createAnthropicClient(runtimeCfg.require("ANTHROPIC_API_KEY"), supabase);
    // Load enabled HTTP tools BEFORE the waitUntil boundary so new tools
    // (pure DB data) work immediately without edge-function redeploy.
    httpTools = await loadHttpTools(supabase);
  } catch (configErr) {
    const errMsg = configErr instanceof Error ? configErr.message : String(configErr);
    // Mark draft as failed so it doesn't stay stuck 'pending'.
    await supabase
      .from("drafts")
      .update({ status: "failed", agent_metadata: { error: `config: ${errMsg}` } })
      .eq("id", draft.id);
    console.error("generate-response config resolution failed:", errMsg);
    return new Response(
      JSON.stringify({ ok: false, error: `config: ${errMsg}` }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  // El trabajo del agente tarda 60-80s. Si lo hiciéramos antes de responder,
  // el runtime mata la función cuando el cliente (pg_net / fire-and-forget) se
  // desconecta, dejando el draft 'pending' para siempre. Por eso devolvemos 200
  // de inmediato y corremos el trabajo lento bajo EdgeRuntime.waitUntil, que
  // mantiene la función viva hasta que termine aunque el cliente se vaya.
  const slowWork = (async () => {
    try {
      const lead = await getLead(batch.leadId);
      const { data: rawPromos } = await supabase
        .from("promotions")
        .select("name, content, kind, starts_at, ends_at, weekdays")
        .eq("enabled", true);
      const promoCtx = buildPromoContext((rawPromos ?? []) as PromoRow[], timezone);
      // Situaciones vigentes (contexto ambiental que el agente SIEMPRE considera).
      const { data: rawSituaciones } = await supabase
        .from("situations")
        .select("title, content, starts_at, ends_at")
        .eq("enabled", true);
      const situacionesCtx = buildSituationContext((rawSituaciones ?? []) as SituationRow[], timezone);
      // Detección de comentario: si ALGÚN mensaje del batch tiene is_comment=true,
      // inyectamos comment_instructions al agente. LÍNEA ROJA: solo esto cambia
      // del flujo normal (sweep/debounce/guardas/promos/usage intactos).
      const batchHasComment = batchMsgs.some((m) => m.is_comment === true);
      let commentInstructions: string | null = null;
      if (batchHasComment) {
        const rawInstructions = (cfg as Record<string, unknown> | null)?.comment_instructions;
        commentInstructions = typeof rawInstructions === "string" && rawInstructions.trim()
          ? rawInstructions.trim()
          : "El mensaje vino de un comentario público en una publicación de Instagram. Tu respuesta sale por DM: reconocé el origen con naturalidad (ej: \"vi tu comentario 😊\"), andá directo al grano.";
      }

      // Historial determinístico del lead, leído de la DB (excluimos el batch
      // actual: ya viaja en [MENSAJES DEL LEAD]). Es la ÚNICA fuente del historial:
      // el agente ya no lee ni reescribe conversation.md en el Memory Store.
      const history = await fetchLeadHistory(supabase, batch.leadId, {
        excludeMessageIds: batchIds,
        maxMessages: 24,
        truncateChars: 600,
      });

      const contextMessage = buildContext({
        lead,
        messages: batchMsgs.map((m) => ({
          content: m.content as string,
          created_at: m.created_at as string,
        })),
        history,
        verticalSlug: vertical.slug,
        verticalPrompt: vertical.system_prompt,
        channel: latestMsg.source,
        classification: latestMsg.classification as Record<string, unknown> | null,
        masterPath,
        leadsPath,
        now: formatNow(timezone),
        timezone,
        businessHours: {
          active: isBusinessHours(bizCfg),
          label: businessHoursLabel(bizCfg),
        },
        activePromos: promoCtx.activePromos,
        upcomingEvents: promoCtx.upcomingEvents,
        situaciones: situacionesCtx,
        commentInstructions,
        dreamsDigest: (resolvedCfg.get("DREAMS_DIGEST") ?? "").trim() || null,
      });

      const outcome = await runAgent({
        leadId: batch.leadId,
        contextMessage,
        agentId,
        environmentId,
        memstoreMaster,
        memstoreLeads,
        anthropic,
        httpTools,
        cfg: resolvedCfg,
        kommoLeadId: lead.kommo_lead_id != null ? Number(lead.kommo_lead_id) : null,
        kommoContactId: lead.kommo_contact_id != null ? Number(lead.kommo_contact_id) : null,
        crm,
        bcvEnabled: cfg?.bcv_rate_enabled === true,
        currentKommoStageId: lead.kommo_stage_id != null ? Number(lead.kommo_stage_id) : null,
        currentKommoPipelineId: lead.kommo_pipeline_id != null ? Number(lead.kommo_pipeline_id) : null,
        draftId: draft.id,
      });

      if (!outcome.responseText) {
        throw new Error("agent devolvió respuesta vacía");
      }

      // ---- Respuesta pública IA (comentario de Instagram) — fail-open ----
      // Si el batch vino de un comentario y el operador tiene la feature activa,
      // generamos una respuesta pública corta (COMMENT_REPLY_MODEL) gobernada por sus reglas.
      // CAP DURO: 280 chars. Falla → sin public_reply (el DM sigue igual).
      let publicReply: string | undefined;
      if (
        batchHasComment &&
        (cfg as Record<string, unknown> | null)?.comment_reply_enabled === true
      ) {
        const rawRules = (cfg as Record<string, unknown> | null)?.comment_reply_rules;
        const replyRules = typeof rawRules === "string" && rawRules.trim()
          ? rawRules.trim()
          : "Respuesta CORTA (máximo 200 caracteres), sin saludos largos ni presentaciones: directo al grano. NO des precios, montos ni promociones con números en público — para eso invitá al DM (\"te pasamos el detalle por DM 💛\"). Tono cercano, máximo 1 emoji. Si el comentario es solo elogio o emojis, agradecé breve.";
        try {
          const operator = resolvedCfg.getOr("OPERATOR_NAME", "el negocio");
          // Modelo de la respuesta pública: editable desde /consumo.
          const commentReplyModel = modelFor(resolvedCfg, "COMMENT_REPLY_MODEL");
          // El comentario es texto del lead (no confiable): va como turno saneado.
          const batchTurns = batchMsgs
            .map((m: MsgRow) => String(m.content ?? "").trim())
            .filter(Boolean)
            .map((t: string) => turn("lead", t))
            .join("\n");
          const dmPreview = turn("agente", outcome.responseText, { maxChars: 500 });
          const replyStart = Date.now();
          const replyRes = await anthropic.messages.create({
            model: commentReplyModel,
            max_tokens: LLM_PROFILES.commentReply.maxTokens,
            output_config: { ...effortFor(commentReplyModel, LLM_PROFILES.commentReply.effort) },
            system: `Sos el community manager de ${operator}. Redactás UNA respuesta pública a un comentario de Instagram. Reglas OBLIGATORIAS del negocio:\n${replyRules}\nRespondé SOLO con el texto del comentario de respuesta, sin comillas ni explicaciones.`,
            messages: [
              {
                role: "user",
                content: `${UNTRUSTED_NOTICE}\n\nComentario del cliente:\n${batchTurns}\n\nLa respuesta completa que le enviaremos por DM (para tu contexto, NO la repitas):\n${dmPreview}`,
              },
            ],
          });
          // Adaptive thinking: content[0] puede ser `thinking`. textOf lee el
          // bloque de texto y tira ante refusal / max_tokens → cae al catch
          // fail-open de abajo (el DM sale igual, sin respuesta pública).
          const rawReply = textOf(replyRes, "comment_reply").trim();
          if (rawReply) {
            // Cap duro 280 chars: cortar en el último espacio antes del límite.
            publicReply = truncateGraphemes(rawReply, 280, { wordBoundary: true });
          }
          // Registrar consumo de la respuesta pública — fail-open.
          await recordUsage(supabase, {
            component: "comment_reply",
            model: commentReplyModel,
            inputTokens: replyRes.usage?.input_tokens,
            outputTokens: replyRes.usage?.output_tokens,
            runtimeMs: Date.now() - replyStart,
            leadId: batch.leadId,
            draftId: draft.id,
            metadata: { batch_size: batchMsgs.length },
            pricingOverrideRaw: resolvedCfg.get("AI_PRICING_OVERRIDES"),
          });
        } catch (replyErr) {
          await recordFailedLlmUsage(supabase, replyErr, {
            component: "comment_reply", model: modelFor(resolvedCfg, "COMMENT_REPLY_MODEL"),
            leadId: batch.leadId, draftId: draft.id,
            pricingOverrideRaw: resolvedCfg.get("AI_PRICING_OVERRIDES"),
          });
          // fail-open: la parte pública no sale pero el DM sigue.
          console.warn("generate-response: comment_reply generation failed (fail-open):", replyErr instanceof Error ? replyErr.message : String(replyErr));
        }
      }

      // Guardarraíl (ver definición arriba): concurso de IG + teléfono en la
      // respuesta → nunca auto-enviar, sin importar bypass_review ni vertical.
      const contestPhoneGuard =
        batchHasContestMarker(batchMsgs) && VE_PHONE_RE.test(outcome.responseText);

      // La respuesta PÚBLICA (el canal más expuesto: la lee cualquiera) pasa por el
      // MISMO verificador que el DM, ya al generarla (_shared/outbound.ts). Con
      // residuo interno se OMITE la pública (el DM sigue si está limpio), queda
      // marcada en el draft y se alerta. publish-to-kommo la vuelve a verificar al
      // escribirla.
      let publicReplyBlocked: string | null = null;
      if (publicReply) {
        publicReplyBlocked = outboundLeak(publicReply);
        if (publicReplyBlocked) {
          console.error(`generate-response: respuesta pública del draft ${draft.id} bloqueada — ${publicReplyBlocked}`);
          publicReply = undefined;
          const { error: blockAlertErr } = await supabase.from("alerts").insert({
            kind: "outbound_blocked",
            severity: "warning",
            title: "Se bloqueó la respuesta pública a un comentario",
            description:
              `El texto de la respuesta pública traía residuo interno del agente (${publicReplyBlocked}) y se descartó. ` +
              "El mensaje privado (DM) sigue su curso. Revisá el comentario y respondé a mano si corresponde.",
            ref_table: "drafts",
            ref_id: draft.id,
            metadata: { part: "public_reply", reason: publicReplyBlocked, stage: "generate" },
          });
          if (blockAlertErr) console.warn("alert outbound_blocked:", blockAlertErr.message);
        }
      }

      // GUARD DE FUGA INTERNA (_shared/response-guard.ts) — si el bloque de
      // respuesta vino malformado o el texto trae residuo de razonamiento/
      // tool-calling interno, el draft NUNCA se auto-aprueba. Esto gana sobre
      // forceReview/bypass/vertical: no hay combinación de esos tres flags
      // que autorice enviar un mensaje que puede ser el scaffolding interno
      // del sistema en vez de una respuesta real para el cliente.
      const guardBlocked = outcome.leak.reason != null || !outcome.leak.wellFormed;
      if (guardBlocked) {
        console.error(
          `generate-response: GUARD (internal_leak) draft ${draft.id}: ${outcome.leak.reason ?? "bloque malformado"} → forzando revisión humana`
        );
      }

      // forceReview (revisión humana) → siempre pending para que el humano
      // apruebe/edite. bypass → siempre approved (publica todo, ignora review).
      // Resto → lógica normal por vertical.
      const status = guardBlocked
        ? "pending"
        : forceReview
        ? "pending"
        : contestPhoneGuard
        ? "pending"
        : bypass
        ? "approved"
        : vertical.auto_reply && !vertical.requires_review
        ? "approved"
        : "pending";

      await supabase
        .from("drafts")
        .update({
          body: outcome.responseText,
          status,
          agent_metadata: {
            session_id: outcome.sessionId,
            tool_calls: outcome.toolCalls,
            duration_ms: outcome.durationMs,
            model: modelFor(resolvedCfg, "AGENT_MODEL"),
            vertical: vertical.slug,
            ...(batchHasComment ? { from_comment: true } : {}),
            ...(publicReply ? { public_reply: publicReply } : {}),
            ...(publicReplyBlocked
              ? { public_reply_blocked: true, guard_part: "public_reply", guard_reason: publicReplyBlocked, guard_stage: "generate" }
              : {}),
            ...(contestPhoneGuard ? { forced_review_reason: "contest_marker_with_phone" } : {}),
            ...(guardBlocked
              ? { guard_blocked: true, guard_reason: outcome.leak.reason, guard_kind: "internal_leak" }
              : {}),
            // Observabilidad del verificador: solo si hubo reproceso en sesión
            // o quedó algo pendiente sobre el texto final.
            ...(outcome.leak.attempts > 0 || outcome.leak.reason || !outcome.leak.wellFormed
              ? { leak_verify: outcome.leak }
              : {}),
          },
        })
        .eq("id", draft.id)
        // Solo si sigue pending: si el sweep lo borró (run dado por muerto) o
        // un humano lo resolvió mientras generábamos, no pisamos nada.
        .eq("status", "pending");

      // Captura fail-open de consumo CMA (helper compartido con follow-up-scan).
      await captureSessionUsage(supabase, {
        apiKey: resolvedCfg.require("ANTHROPIC_API_KEY"),
        sessionId: outcome.sessionId,
        component: "generate_response",
        model: modelFor(resolvedCfg, "AGENT_MODEL"),
        leadId: batch.leadId,
        draftId: draft.id,
        fallbackRuntimeMs: outcome.durationMs,
        metadata: { vertical: vertical.slug, tool_calls: outcome.toolCalls },
        pricingOverrideRaw: resolvedCfg.get("AI_PRICING_OVERRIDES"),
      });

      if (status === "approved") {
        try {
          const pubRes = await callInternal(supabase, "publish-to-kommo", {});
          if (!pubRes.ok) console.warn("publish-to-kommo:", pubRes.status);
        } catch (e) {
          console.warn("publish-to-kommo failed:", e);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await supabase
        .from("drafts")
        .update({ status: "failed", agent_metadata: { error: errMsg } })
        .eq("id", draft.id)
        .eq("status", "pending");
      console.error("generate-response slowWork failed:", errMsg);
    }
  })();

  // @ts-ignore: EdgeRuntime existe en Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(slowWork);
  } else {
    // Fallback local (sin EdgeRuntime): esperar el trabajo.
    await slowWork;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      draft_id: draft.id,
      message_id: latestMsg.id,
      batch_size: batchMsgs.length,
      accepted: true,
    }),
    { status: 202, headers: { "content-type": "application/json" } }
  );
});
