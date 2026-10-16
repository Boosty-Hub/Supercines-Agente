// Edge Function: evaluate-outcomes
//
// Para cada draft enviado (auto_sent/sent), corre cada grader enabled y
// guarda una fila en outcomes. Idempotente: usa UNIQUE(draft_id, grader_id),
// nunca duplica.
//
// Inputs:
//   POST { draft_id }      → evalúa solo ese draft
//   POST {}                → sweep últimos N drafts enviados <72h sin todos los outcomes
//
// Graders:
//   - source='llm_judge':  llama al GRADER_MODEL (Haiku 5.5 por defecto) con el prompt del grader
//   - source='automatic':  dispatch por slug (length_appropriate, lead_replied, etc.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { authorizeInternal } from "../_shared/auth.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.95.1";
import { jsonOf, LLM_PROFILES } from "../_shared/llm.ts";
import { effortFor, modelFor } from "../_shared/models.ts";
import { getBudgetGate } from "../_shared/budget.ts";
import {
  buildGraderContext,
  type EvidenceReference,
  graderReferences,
  HISTORY_LIMITS,
  LEAD_BATCH_LIMITS,
  type VoiceReference,
  VOICE_REF_LIMITS,
} from "../_shared/grader-prompt.ts";
import { fetchSessionEvidence, type AgentEvidence, type SessionEventsClient } from "../_shared/grader-evidence.ts";
import { errorAttemptsOf, shouldEvaluate, type ExistingOutcome } from "../_shared/outcome-retry.ts";
import { GRADER_PASS_FAIL_SCHEMA, GRADER_SCORE_SCHEMA } from "../_shared/llm-schemas.ts";
import { draftText } from "../_shared/draft-text.ts";
import { fetchLeadHistory } from "../_shared/history.ts";
import { loadConfig, type ConfigReader } from "../_shared/config.ts";
import { recordFailedLlmUsage, recordUsage } from "../_shared/usage.ts";
import { createAnthropicClient } from "../_shared/anthropic-client.ts";
import { isSystemHalted, haltedResponse, logHalted } from "../_shared/halt.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

type Grader = {
  id: string;
  slug: string;
  name: string;
  prompt: string;
  scale: "numeric_0_1" | "pass_fail";
  weight: number;
  enabled: boolean;
  source: "llm_judge" | "automatic" | "manual";
};

type DraftWithContext = {
  id: string;
  body: string;
  edited_body: string | null;
  sent_at: string | null;
  message_id: string;
  agent_metadata: Record<string, unknown> | null;
  // deno-lint-ignore no-explicit-any
  messages: any;
};

async function getEnabledGraders(): Promise<Grader[]> {
  const { data, error } = await supabase
    .from("graders")
    .select("id, slug, name, prompt, scale, weight, enabled, source")
    .eq("enabled", true);
  if (error) throw new Error(`graders: ${error.message}`);
  return (data ?? []) as Grader[];
}

async function getDraftsToEvaluate(draftId?: string): Promise<DraftWithContext[]> {
  if (draftId) {
    const { data, error } = await supabase
      .from("drafts")
      .select(
        "id, body, edited_body, sent_at, message_id, agent_metadata, messages!drafts_message_id_fkey(content, source, lead_id, classification, verticals(slug))"
      )
      .eq("id", draftId)
      .single();
    if (error) throw new Error(`draft ${draftId}: ${error.message}`);
    return data ? [data as DraftWithContext] : [];
  }
  // Sweep: drafts sent en últimas 72h
  const cutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("drafts")
    .select(
      "id, body, edited_body, sent_at, message_id, agent_metadata, messages!drafts_message_id_fkey(content, source, lead_id, classification, verticals(slug))"
    )
    .in("status", ["auto_sent", "sent"])
    .gte("sent_at", cutoff)
    .order("sent_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(`drafts: ${error.message}`);
  return (data ?? []) as DraftWithContext[];
}

async function getExistingOutcomes(draftId: string): Promise<Map<string, ExistingOutcome>> {
  const { data } = await supabase
    .from("outcomes")
    .select("grader_id, score, metadata")
    .eq("draft_id", draftId);
  return new Map(
    (data ?? []).map((o) => [o.grader_id as string, { score: o.score as number | null, metadata: o.metadata }]),
  );
}

/**
 * Referencia del operador para los graders que la piden (graderReferences): el SYSTEM_PROMPT
 * (con su nombre sustituido; voz para voice_match y datos del negocio para no_hallucination)
 * y algunos voice_samples. Una sola lectura por invocación; fail-soft: sin referencia el
 * grader sigue (y el prompt lo dice).
 */
async function loadOperatorReference(cfg: ConfigReader): Promise<VoiceReference> {
  const operator = cfg.getOr("OPERATOR_NAME", "el operador");
  const systemPrompt = (cfg.get("SYSTEM_PROMPT") ?? "").replaceAll("{{OPERATOR_NAME}}", operator);
  let samples: string[] = [];
  try {
    const { data, error } = await supabase
      .from("voice_samples")
      .select("content")
      .order("created_at", { ascending: false })
      .limit(VOICE_REF_LIMITS.samples);
    if (error) throw error;
    samples = (data ?? []).map((r) => String(r.content ?? "")).filter((x) => x.trim());
  } catch (err) {
    console.warn("evaluate-outcomes: voice_samples no disponible (fail-soft):", err instanceof Error ? err.message : String(err));
  }
  return { systemPrompt, samples };
}

/** Mensajes del lead que cubre el draft (su lote), en orden. Fail-soft: [] = usar draft.messages. */
async function loadLeadBatch(draftId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("content, created_at")
    .eq("answered_by_draft_id", draftId)
    // Los ÚLTIMOS del lote (los que la respuesta contestó), luego en orden cronológico.
    .order("created_at", { ascending: false })
    .limit(LEAD_BATCH_LIMITS.messages);
  if (error) {
    console.warn("evaluate-outcomes: lote del draft no disponible (fail-soft):", error.message);
    return [];
  }
  return (data ?? []).reverse().map((r) => String(r.content ?? "")).filter((x) => x.trim());
}

/**
 * Conversación previa a la respuesta del draft (graderReferences → "history"): turnos
 * saneados anteriores al primer mensaje de su lote, sin el lote mismo. Fail-soft como
 * fetchLeadHistory: "" = sin historial (el prompt lo dice).
 */
async function loadPriorHistory(draft: DraftWithContext): Promise<string> {
  const leadId = draft.messages?.lead_id;
  if (typeof leadId !== "string" || !leadId) return "";
  const { data, error } = await supabase
    .from("messages")
    .select("id, created_at")
    .eq("answered_by_draft_id", draft.id)
    .order("created_at", { ascending: true });
  if (error) {
    console.warn("evaluate-outcomes: lote para el historial no disponible (fail-soft):", error.message);
    return "";
  }
  const batch = data ?? [];
  const before = (batch[0]?.created_at as string | undefined) ?? undefined;
  return await fetchLeadHistory(supabase, leadId, {
    before,
    excludeMessageIds: batch.map((m) => m.id as string),
    maxMessages: HISTORY_LIMITS.messages,
    truncateChars: HISTORY_LIMITS.turnChars,
  });
}

/**
 * Evidencia de la sesión del agente para los graders que verifican hechos. Sin
 * session_id → null (el prompt lo dice). Si la API de Anthropic falla, LANZA: el catch
 * de evaluateDraft deja un ERROR reintentable (nunca se evalúa «sin KB» por un corte).
 */
async function loadSessionEvidence(draft: DraftWithContext, anthropic: Anthropic): Promise<AgentEvidence | null> {
  const sid = draft.agent_metadata?.session_id;
  if (typeof sid !== "string" || !sid) return null;
  try {
    return await fetchSessionEvidence(anthropic as unknown as SessionEventsClient, sid);
  } catch (err) {
    throw new Error(`evidencia de la sesión ${sid}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------- LLM-judge ----------------
async function runLlmJudge(
  grader: Grader,
  draft: DraftWithContext,
  anthropic: Anthropic,
  model: string,
  refs: { voice: VoiceReference | null; evidence: EvidenceReference | null; history: string | null; leadTexts: string[] },
): Promise<{ score: number | null; passed: boolean | null; reasoning: string; __usage?: Anthropic.Usage }> {
  const msg = draft.messages;
  const verticalSlug = msg?.verticals?.slug ?? "(desconocida)";
  const channel = msg?.source ?? "(desconocido)";
  const responseText = draftText(draft);

  // El texto del lead (y la respuesta del agente, que puede repetirlo) entra al
  // juez como turnos saneados + UNTRUSTED_NOTICE: ver _shared/grader-prompt.ts.
  const userContext = buildGraderContext({
    channel,
    vertical: verticalSlug,
    // El lote completo que cubre la respuesta (antes solo draft.message_id: con 3 mensajes
    // cortados el juez veía uno solo y no podía saber qué se había preguntado).
    leadText: refs.leadTexts.length > 0 ? refs.leadTexts : (msg?.content ?? ""),
    agentText: responseText,
    voiceReference: refs.voice,
    evidence: refs.evidence,
    history: refs.history,
  });

  const isPassFail = grader.scale === "pass_fail";
  const schema = isPassFail ? GRADER_PASS_FAIL_SCHEMA : GRADER_SCORE_SCHEMA;

  const response = await anthropic.messages.create({
    model,
    max_tokens: LLM_PROFILES.grader.maxTokens,
    system: grader.prompt,
    messages: [{ role: "user", content: userContext }],
    output_config: {
      ...effortFor(model, LLM_PROFILES.grader.effort),
      format: { type: "json_schema", schema },
    },
  });

  // Adaptive thinking: content[0] puede ser `thinking`. jsonOf lee el bloque de
  // texto y falla explícito ante refusal / max_tokens (ver _shared/llm.ts); el
  // catch de evaluateDraft lo registra como outcome con ERROR visible.
  const parsed = jsonOf<{ passed?: boolean; score?: number; reasoning?: string }>(response, `grader:${grader.slug}`);

  if (isPassFail) {
    return {
      score: parsed.passed ? 1 : 0,
      passed: !!parsed.passed,
      reasoning: String(parsed.reasoning ?? ""),
      __usage: response.usage,
    };
  }
  const s = Math.max(0, Math.min(1, Number(parsed.score ?? 0)));
  return {
    score: s,
    passed: s >= 0.6,
    reasoning: String(parsed.reasoning ?? ""),
    __usage: response.usage,
  };
}

// ---------------- Automatic graders ----------------
function lengthAppropriate(
  channel: string,
  text: string
): { score: number; passed: boolean; reasoning: string } {
  const words = text.split(/\s+/).filter(Boolean).length;
  // Rangos ideales por canal
  const ranges: Record<string, [number, number]> = {
    instagram_dm: [20, 80],
    instagram_comment: [20, 80],
    whatsapp: [20, 150],
    web_form: [40, 300],
    telegram: [20, 150],
    facebook: [20, 150],
  };
  const [min, max] = ranges[channel] ?? [20, 200];
  if (words >= min && words <= max) {
    return {
      score: 1,
      passed: true,
      reasoning: `${words} palabras, dentro del rango ideal ${min}-${max} para ${channel}.`,
    };
  }
  // Penalización suave: decae linealmente fuera del rango
  const targetMid = (min + max) / 2;
  const tolerance = max - min;
  const dist = words < min ? min - words : words - max;
  const score = Math.max(0, 1 - dist / tolerance);
  return {
    score,
    passed: score >= 0.5,
    reasoning: `${words} palabras, fuera del rango ${min}-${max} (mid ${targetMid}). Score=${score.toFixed(2)}.`,
  };
}

async function leadReplied(
  draftSentAt: string,
  leadId: string
): Promise<{ score: number | null; passed: boolean | null; reasoning: string }> {
  // Si pasaron menos de 5 minutos, NO evaluamos todavía — devolvemos null
  const sentAge = Date.now() - new Date(draftSentAt).getTime();
  if (sentAge < 5 * 60 * 1000) {
    return {
      score: null,
      passed: null,
      reasoning: "esperando ventana (5 min mínimo después del envío)",
    };
  }
  // Buscamos inbound posterior al draft, dentro de 72h
  const { count } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("direction", "inbound")
    .gte("created_at", draftSentAt);
  const replied = (count ?? 0) > 0;
  return {
    score: replied ? 1 : 0,
    passed: replied,
    reasoning: replied
      ? "lead respondió después del envío"
      : "lead no respondió todavía (decisión pendiente; se re-evalúa hasta 72h)",
  };
}

async function leadConverted(
  _leadId: string
): Promise<{ score: number | null; passed: boolean | null; reasoning: string }> {
  // Requiere mapeo de pipeline_id de Kommo a "estados ganados". TODO paso 13.
  return {
    score: null,
    passed: null,
    reasoning: "no implementado todavía — requiere mapeo de pipeline_status_id de Kommo",
  };
}

async function runAutomatic(
  grader: Grader,
  draft: DraftWithContext
): Promise<{ score: number | null; passed: boolean | null; reasoning: string }> {
  const msg = draft.messages;
  const text = draftText(draft);
  switch (grader.slug) {
    case "length_appropriate":
      return lengthAppropriate(msg?.source ?? "unknown", text);
    case "lead_replied":
      if (!draft.sent_at) return { score: null, passed: null, reasoning: "draft no enviado" };
      return await leadReplied(draft.sent_at, msg?.lead_id);
    case "lead_converted":
      return await leadConverted(msg?.lead_id);
    default:
      return { score: null, passed: null, reasoning: `automatic grader desconocido: ${grader.slug}` };
  }
}

// ---------------- Evaluación principal ----------------
function graderMetadata(grader: Grader, graderModel: string): Record<string, unknown> {
  return grader.source === "llm_judge" ? { grader_model: graderModel } : {};
}

async function evaluateDraft(
  draft: DraftWithContext,
  graders: Grader[],
  anthropic: Anthropic,
  cfg: ConfigReader,
  llmBlocked: boolean,
  operatorReference: () => Promise<VoiceReference>,
): Promise<number> {
  // Modelo de los graders: editable desde /consumo (DB-first, fallback Haiku 5.5).
  const graderModel = modelFor(cfg, "GRADER_MODEL");
  const existing = await getExistingOutcomes(draft.id);
  let count = 0;
  // Por draft, perezoso: solo si algún grader pendiente lo usa (y una sola vez).
  let batch: Promise<string[]> | null = null;
  let session: Promise<AgentEvidence | null> | null = null;
  let prior: Promise<string> | null = null;

  for (const grader of graders) {
    // Si ya existe, skip — excepto lead_replied (mutable) y las filas de ERROR, que se
    // reintentan hasta MAX_ERROR_ATTEMPTS (antes quedaban en ERROR para siempre).
    const isMutable = grader.source === "automatic" && grader.slug === "lead_replied";
    const prev = existing.get(grader.id);
    if (!shouldEvaluate(prev, isMutable)) continue;
    // Techo de gasto (>=100%): los graders LLM esperan (no se escribe outcome; el
    // draft se vuelve a evaluar al reanudar). Los automáticos no cuestan nada.
    if (llmBlocked && grader.source === "llm_judge") continue;

    try {
      let result: { score: number | null; passed: boolean | null; reasoning: string; __usage?: Anthropic.Usage };
      if (grader.source === "llm_judge") {
        const needs = graderReferences(grader);
        const operator = needs.size > 0 ? await operatorReference() : null;
        const evidence: EvidenceReference | null = needs.has("evidence")
          ? {
            systemPrompt: operator?.systemPrompt ?? "",
            session: await (session ??= loadSessionEvidence(draft, anthropic)),
            // Se evalúa lo ENVIADO (draftText); si una persona lo corrigió, el juez lo sabe.
            editedByHuman: draftText(draft) !== draft.body,
          }
          : null;
        result = await runLlmJudge(grader, draft, anthropic, graderModel, {
          voice: needs.has("voice") ? operator : null,
          evidence,
          history: needs.has("history") ? await (prior ??= loadPriorHistory(draft)) : null,
          leadTexts: await (batch ??= loadLeadBatch(draft.id)),
        });
      } else {
        result = await runAutomatic(grader, draft);
      }

      // null score = todavía no evaluable; skip insert
      if (result.score === null) continue;

      // upsert (para mutables como lead_replied)
      await supabase.from("outcomes").upsert(
        {
          draft_id: draft.id,
          grader_id: grader.id,
          score: result.score,
          passed: result.passed,
          reasoning: result.reasoning,
          // Modelo del juez: alerts-scan solo compara outcomes del MISMO juez (un cambio
          // de modelo mueve la escala sin que el agente cambie).
          metadata: graderMetadata(grader, graderModel),
        },
        { onConflict: "draft_id,grader_id" }
      );
      // Captura fail-open de consumo grader (solo llm_judge)
      if (grader.source === "llm_judge") {
        const u = (result as { __usage?: Anthropic.Usage }).__usage;
        await recordUsage(supabase, {
          component: "grader", model: graderModel,
          inputTokens: u?.input_tokens,
          outputTokens: u?.output_tokens,
          cacheReadTokens: u?.cache_read_input_tokens,
          draftId: draft.id,
          leadId: (draft.messages as any)?.lead_id ?? null,
          metadata: { grader_id: grader.id, grader_slug: grader.slug },
          pricingOverrideRaw: cfg.get("AI_PRICING_OVERRIDES"),
        });
      }
      count++;
    } catch (err) {
      await recordFailedLlmUsage(supabase, err, {
        component: "grader", model: graderModel, draftId: draft.id,
        metadata: { grader_id: grader.id, grader_slug: grader.slug },
        pricingOverrideRaw: cfg.get("AI_PRICING_OVERRIDES"),
      });
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`grader ${grader.slug} en draft ${draft.id}:`, msg);
      // Insert fila de error para visibilidad
      await supabase.from("outcomes").upsert(
        {
          draft_id: draft.id,
          grader_id: grader.id,
          score: null,
          passed: null,
          reasoning: `ERROR: ${msg}`,
          metadata: { ...graderMetadata(grader, graderModel), error: true, error_attempts: errorAttemptsOf(prev) + 1 },
        },
        { onConflict: "draft_id,grader_id" }
      );
    }
  }
  return count;
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("evaluate-outcomes OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  // Gate interno: esta función NO es un webhook público (ver _shared/auth.ts).
  {
    const denied = await authorizeInternal(req, supabase);
    if (denied) return denied;
  }

  let body: { draft_id?: string } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    // ignore
  }

  try {
    // Apagado total (0057): corta ANTES de tocar Anthropic (los graders son
    // LLM). evaluate-outcomes no lee kommo_publish_config para nada más, así
    // que usa el fetch cacheado.
    if (await isSystemHalted(supabase)) {
      logHalted("evaluate-outcomes");
      return haltedResponse({ drafts_processed: 0, outcomes_written: 0 });
    }

    // Resolve config at request time: DB-first, then env fallback.
    const cfg = await loadConfig(supabase);
    const anthropic = createAnthropicClient(cfg.require("ANTHROPIC_API_KEY"), supabase);
    const llmBlocked = (await getBudgetGate(supabase, cfg)).blockGenerate;

    const graders = await getEnabledGraders();
    const drafts = await getDraftsToEvaluate(body.draft_id);
    let totalEvaluated = 0;
    let voiceRef: Promise<VoiceReference> | null = null;
    const operatorReference = () => (voiceRef ??= loadOperatorReference(cfg));
    for (const d of drafts) {
      totalEvaluated += await evaluateDraft(d, graders, anthropic, cfg, llmBlocked, operatorReference);
    }
    return new Response(
      JSON.stringify({
        ok: true,
        drafts_processed: drafts.length,
        outcomes_written: totalEvaluated,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("evaluate-outcomes:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
