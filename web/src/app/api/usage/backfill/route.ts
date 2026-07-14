import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { configValue } from "@/lib/runtime-config";
import { costUsd, parsePricingOverride } from "@/lib/ai-pricing";

export const runtime = "nodejs";
export const maxDuration = 300; // backfill puede tomar varios minutos

const BATCH_SIZE = 200;

// POST /api/usage/backfill
// Backfill idempotente de usage_events para sesiones históricas.
// Devuelve { done: boolean, cursor: string | null, inserted: number }
// El cliente llama en loop hasta done=true.
export async function POST(request: Request) {
  // Auth obligatorio
  const authClient = createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { cursor?: string } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch { /* cursor es opcional */ }

  const cursor = typeof body.cursor === "string" ? body.cursor : null;

  const supabase = createServiceClient();
  const pricingOverrideRaw = await configValue("AI_PRICING_OVERRIDES");
  const pricingOverride = parsePricingOverride(pricingOverrideRaw);
  const anthropicKey = await configValue("ANTHROPIC_API_KEY");

  let totalInserted = 0;
  let nextCursor: string | null = null;
  let done = false;

  // ---- Segmento CMA: drafts con session_id sin usage ----
  try {
    let draftsQuery = supabase
      .from("drafts")
      .select("id, agent_metadata, created_at, messages(lead_id)")
      .not("agent_metadata->session_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (cursor) {
      draftsQuery = draftsQuery.gt("created_at", cursor);
    }

    const { data: drafts, error: draftsErr } = await draftsQuery;
    if (draftsErr) {
      console.warn("backfill: drafts query error", draftsErr.message);
    } else if (drafts && drafts.length > 0) {
      const lastDraft = drafts[drafts.length - 1];
      nextCursor = lastDraft.created_at as string;

      if (drafts.length < BATCH_SIZE) {
        // Último batch CMA → checar classify/graders también
        done = false; // se irá a los siguientes segmentos si cursor se resetea
      }

      for (const draft of drafts) {
        const meta = (draft.agent_metadata ?? {}) as Record<string, unknown>;
        const sessionId = meta.session_id as string | null;
        if (!sessionId) continue;
        // Fecha real del evento = fecha del draft (no la hora del backfill) y
        // lead vía draft → message. Sin esto el timeline de /consumo muestra
        // un pico falso a la hora en que corrió el backfill.
        const msgRel = draft.messages as { lead_id: string | null } | { lead_id: string | null }[] | null;
        const draftLeadId = Array.isArray(msgRel) ? msgRel[0]?.lead_id ?? null : msgRel?.lead_id ?? null;

        // Verificar idempotencia via unique index session_id
        const { count } = await supabase
          .from("usage_events")
          .select("id", { count: "exact", head: true })
          .eq("session_id", sessionId);

        if (count && count > 0) continue; // ya existe

        let inserted = false;

        // Intentar GET exacto a la API de Anthropic
        if (anthropicKey) {
          try {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), 15000);
            const r = await fetch(`https://api.anthropic.com/v1/sessions/${sessionId}?beta=true`, {
              headers: {
                "x-api-key": anthropicKey,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "managed-agents-2026-04-01",
              },
              signal: ac.signal,
            });
            clearTimeout(t);

            if (r.ok) {
              const s = await r.json() as {
                usage?: Record<string, unknown>;
                stats?: Record<string, unknown>;
                status?: string;
              };
              const u = s.usage ?? {};
              const cc = (u.cache_creation ?? {}) as Record<string, unknown>;
              const runtimeMs = Math.round(((s.stats?.active_seconds as number) ?? 0) * 1000);
              const model = (meta.model as string) ?? "claude-sonnet-4-6";
              const cost = costUsd({
                model,
                inputTokens: (u.input_tokens as number) ?? null,
                outputTokens: (u.output_tokens as number) ?? null,
                cacheReadTokens: (u.cache_read_input_tokens as number) ?? null,
                cacheCreation5m: (cc.ephemeral_5m_input_tokens as number) ?? null,
                cacheCreation1h: (cc.ephemeral_1h_input_tokens as number) ?? null,
                runtimeMs,
                pricingOverride,
              });

              await supabase.from("usage_events").insert({
                component: "generate_response",
                model,
                input_tokens: (u.input_tokens as number) ?? null,
                output_tokens: (u.output_tokens as number) ?? null,
                cache_creation_tokens: ((cc.ephemeral_5m_input_tokens as number) ?? 0) + ((cc.ephemeral_1h_input_tokens as number) ?? 0) || null,
                cache_read_tokens: (u.cache_read_input_tokens as number) ?? null,
                is_estimated: false,
                runtime_ms: runtimeMs || null,
                estimated_cost_usd: cost,
                draft_id: draft.id,
                session_id: sessionId,
                lead_id: draftLeadId,
                created_at: draft.created_at,
                metadata: { source: "backfill", vertical: meta.vertical, status: s.status },
              });
              totalInserted++;
              inserted = true;
            }
          } catch (fetchErr) {
            console.warn("backfill: session GET failed for", sessionId, fetchErr instanceof Error ? fetchErr.message : String(fetchErr));
          }
        }

        // Fallback estimado si GET falló o no hay API key
        if (!inserted) {
          const durationMs = (meta.duration_ms as number) ?? 0;
          const model = (meta.model as string) ?? "claude-sonnet-4-6";
          const cost = costUsd({ model, runtimeMs: durationMs, pricingOverride });
          await supabase.from("usage_events").insert({
            component: "generate_response",
            model,
            is_estimated: true,
            runtime_ms: durationMs || null,
            estimated_cost_usd: cost,
            draft_id: draft.id,
            session_id: sessionId,
            lead_id: draftLeadId,
            created_at: draft.created_at,
            metadata: { source: "backfill", vertical: meta.vertical, error: "session_unavailable" },
          });
          totalInserted++;
        }
      }

      if (drafts.length === BATCH_SIZE) {
        // Hay más drafts por procesar
        return NextResponse.json({ ok: true, done: false, cursor: nextCursor, inserted: totalInserted });
      }
    }
  } catch (e) {
    console.warn("backfill CMA segment error:", e instanceof Error ? e.message : String(e));
  }

  // ---- Segmento classify: messages inbound clasificados sin usage ----
  try {
    for (let page = 0; page < 25; page++) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("id, lead_id, created_at")
        .eq("direction", "inbound")
        .not("vertical_id", "is", null)
        .eq("ignored", false)
        .order("created_at", { ascending: true })
        .range(page * BATCH_SIZE, page * BATCH_SIZE + BATCH_SIZE - 1);
      if (!msgs || msgs.length === 0) break;
      for (const msg of msgs) {
        // Pre-check idempotencia por msg_id en metadata
        const { count } = await supabase
          .from("usage_events")
          .select("id", { count: "exact", head: true })
          .eq("component", "classify")
          .contains("metadata", { msg_id: msg.id });

        if (count && count > 0) continue;

        await supabase.from("usage_events").insert({
          component: "classify",
          model: "claude-haiku-4-5",
          is_estimated: true,
          estimated_cost_usd: 0,
          lead_id: msg.lead_id,
          created_at: msg.created_at,
          metadata: { source: "backfill", msg_id: msg.id },
        });
        totalInserted++;
      }
      if (msgs.length < BATCH_SIZE) break;
    }
  } catch (e) {
    console.warn("backfill classify segment error:", e instanceof Error ? e.message : String(e));
  }

  // ---- Segmento grader: outcomes llm_judge sin usage ----
  try {
    for (let page = 0; page < 25; page++) {
      const { data: outcomes } = await supabase
        .from("outcomes")
        .select("id, draft_id, grader_id, created_at, graders(slug)")
        .eq("source", "llm_judge")
        .order("created_at", { ascending: true })
        .range(page * BATCH_SIZE, page * BATCH_SIZE + BATCH_SIZE - 1);
      if (!outcomes || outcomes.length === 0) break;
      for (const outcome of outcomes) {
        // Pre-check idempotencia por draft_id+grader_id en metadata
        const { count } = await supabase
          .from("usage_events")
          .select("id", { count: "exact", head: true })
          .eq("component", "grader")
          .eq("draft_id", outcome.draft_id)
          .contains("metadata", { grader_id: outcome.grader_id });

        if (count && count > 0) continue;

        await supabase.from("usage_events").insert({
          component: "grader",
          model: "claude-haiku-4-5",
          is_estimated: true,
          estimated_cost_usd: 0,
          draft_id: outcome.draft_id,
          created_at: outcome.created_at,
          metadata: { source: "backfill", grader_id: outcome.grader_id },
        });
        totalInserted++;
      }
      if (outcomes.length < BATCH_SIZE) break;
    }
  } catch (e) {
    console.warn("backfill grader segment error:", e instanceof Error ? e.message : String(e));
  }

  done = true;
  return NextResponse.json({ ok: true, done, cursor: null, inserted: totalInserted });
}
