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
//   - source='llm_judge':  llama a Haiku 4.5 con el prompt del grader
//   - source='automatic':  dispatch por slug (length_appropriate, lead_replied, etc.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@0.95.1";
import { loadConfig, type ConfigReader } from "../_shared/config.ts";
import { recordUsage } from "../_shared/usage.ts";

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
        "id, body, edited_body, sent_at, message_id, messages(content, source, lead_id, classification, verticals(slug))"
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
      "id, body, edited_body, sent_at, message_id, messages(content, source, lead_id, classification, verticals(slug))"
    )
    .in("status", ["auto_sent", "sent"])
    .gte("sent_at", cutoff)
    .order("sent_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(`drafts: ${error.message}`);
  return (data ?? []) as DraftWithContext[];
}

async function getExistingOutcomes(draftId: string): Promise<Set<string>> {
  const { data } = await supabase
    .from("outcomes")
    .select("grader_id")
    .eq("draft_id", draftId);
  return new Set((data ?? []).map((o) => o.grader_id as string));
}

// ---------------- LLM-judge ----------------
async function runLlmJudge(
  grader: Grader,
  draft: DraftWithContext,
  anthropic: Anthropic,
  model: string
): Promise<{ score: number | null; passed: boolean | null; reasoning: string; __usage?: Anthropic.Usage }> {
  const msg = draft.messages;
  const verticalSlug = msg?.verticals?.slug ?? "(desconocida)";
  const channel = msg?.source ?? "(desconocido)";
  const responseText = draft.edited_body ?? draft.body;

  const userContext = `[CONTEXTO]
canal: ${channel}
vertical: ${verticalSlug}

[MENSAJE DEL LEAD]
"""${msg?.content ?? ""}"""

[RESPUESTA DEL AGENTE QUE VAS A EVALUAR]
"""${responseText}"""

Evaluá según las instrucciones del system prompt y devolvé JSON estricto.`;

  const isPassFail = grader.scale === "pass_fail";
  const schema = isPassFail
    ? {
        type: "object",
        properties: {
          passed: { type: "boolean" },
          reasoning: { type: "string" },
        },
        required: ["passed", "reasoning"],
      }
    : {
        type: "object",
        properties: {
          score: { type: "number" },
          reasoning: { type: "string" },
        },
        required: ["score", "reasoning"],
      };

  const response = await anthropic.messages.create({
    model,
    max_tokens: 600,
    system: grader.prompt,
    messages: [{ role: "user", content: userContext }],
    output_config: {
      format: { type: "json_schema", schema },
    },
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("no text block");
  const parsed = JSON.parse(block.text);

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
  const text = draft.edited_body ?? draft.body;
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
async function evaluateDraft(draft: DraftWithContext, graders: Grader[], anthropic: Anthropic, cfg: ConfigReader): Promise<number> {
  // Modelo de los graders: editable desde /consumo (DB-first, fallback Haiku).
  const graderModel = cfg.getOr("GRADER_MODEL", "claude-haiku-4-5");
  const existing = await getExistingOutcomes(draft.id);
  let count = 0;

  for (const grader of graders) {
    // Si ya existe, skip — excepto para automatic que pueden cambiar con el tiempo (lead_replied)
    const isMutable = grader.source === "automatic" && grader.slug === "lead_replied";
    if (existing.has(grader.id) && !isMutable) continue;

    try {
      const result =
        grader.source === "llm_judge"
          ? await runLlmJudge(grader, draft, anthropic, graderModel)
          : await runAutomatic(grader, draft);

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
          metadata: { error: true },
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

  let body: { draft_id?: string } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    // ignore
  }

  try {
    // Resolve config at request time: DB-first, then env fallback.
    const cfg = await loadConfig(supabase);
    const anthropic = new Anthropic({ apiKey: cfg.require("ANTHROPIC_API_KEY") });

    const graders = await getEnabledGraders();
    const drafts = await getDraftsToEvaluate(body.draft_id);
    let totalEvaluated = 0;
    for (const d of drafts) {
      totalEvaluated += await evaluateDraft(d, graders, anthropic, cfg);
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
