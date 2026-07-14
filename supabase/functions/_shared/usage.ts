import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { costUsd, parsePricingOverride, type UsageRow } from "./ai-pricing.ts";

export type RecordUsageInput = Omit<UsageRow, "pricingOverride"> & {
  component: string;
  isEstimated?: boolean;
  leadId?: string | null;
  draftId?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
  pricingOverrideRaw?: string | null;
};

// fail-open ABSOLUTO: cualquier error → log + return. NUNCA propaga.
export async function recordUsage(supabase: SupabaseClient, u: RecordUsageInput): Promise<void> {
  try {
    const ov = parsePricingOverride(u.pricingOverrideRaw);
    const cost = costUsd({ ...u, pricingOverride: ov });
    // deno-lint-ignore no-explicit-any
    await (supabase as any).from("usage_events").insert({
      component: u.component, model: u.model,
      input_tokens: u.inputTokens ?? null, output_tokens: u.outputTokens ?? null,
      cache_creation_tokens: (u.cacheCreation5m ?? 0) + (u.cacheCreation1h ?? 0) || null,
      cache_read_tokens: u.cacheReadTokens ?? null,
      is_estimated: u.isEstimated ?? false,
      runtime_ms: u.runtimeMs ?? null,
      estimated_cost_usd: cost,
      lead_id: u.leadId ?? null, draft_id: u.draftId ?? null,
      session_id: u.sessionId ?? null, metadata: u.metadata ?? null,
    });
  } catch (e) { console.warn("recordUsage failed (ignored):", e instanceof Error ? e.message : String(e)); }
}

// Captura de consumo de una sesión CMA: GET /v1/sessions/{id} (timeout 8s) →
// evento exacto; si el GET falla → evento estimado por fallbackRuntimeMs.
// fail-open ABSOLUTO igual que recordUsage.
export async function captureSessionUsage(
  supabase: SupabaseClient,
  opts: {
    apiKey: string;
    sessionId: string;
    component: string;
    model: string;
    leadId?: string | null;
    draftId?: string | null;
    fallbackRuntimeMs?: number | null;
    metadata?: Record<string, unknown>;
    pricingOverrideRaw?: string | null;
  }
): Promise<void> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(`https://api.anthropic.com/v1/sessions/${opts.sessionId}?beta=true`, {
      headers: {
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "managed-agents-2026-04-01",
      },
      signal: ac.signal,
    });
    clearTimeout(t);
    if (r.ok) {
      const s = await r.json() as { usage?: Record<string, unknown>; stats?: Record<string, unknown>; status?: string };
      const u = s.usage ?? {};
      const cc = (u.cache_creation ?? {}) as Record<string, unknown>;
      await recordUsage(supabase, {
        component: opts.component,
        model: opts.model,
        inputTokens: (u.input_tokens as number) ?? null,
        outputTokens: (u.output_tokens as number) ?? null,
        cacheReadTokens: (u.cache_read_input_tokens as number) ?? null,
        cacheCreation5m: (cc.ephemeral_5m_input_tokens as number) ?? null,
        cacheCreation1h: (cc.ephemeral_1h_input_tokens as number) ?? null,
        runtimeMs: Math.round(((s.stats?.active_seconds as number) ?? 0) * 1000),
        leadId: opts.leadId, draftId: opts.draftId, sessionId: opts.sessionId,
        metadata: { ...(opts.metadata ?? {}), status: s.status },
        pricingOverrideRaw: opts.pricingOverrideRaw,
      });
    } else {
      await recordUsage(supabase, {
        component: opts.component, model: opts.model,
        runtimeMs: opts.fallbackRuntimeMs ?? null,
        leadId: opts.leadId, draftId: opts.draftId, sessionId: opts.sessionId,
        isEstimated: true,
        metadata: { ...(opts.metadata ?? {}), error: `session GET ${r.status}` },
        pricingOverrideRaw: opts.pricingOverrideRaw,
      });
    }
  } catch (e) {
    try {
      await recordUsage(supabase, {
        component: opts.component, model: opts.model,
        runtimeMs: opts.fallbackRuntimeMs ?? null,
        leadId: opts.leadId, draftId: opts.draftId, sessionId: opts.sessionId,
        isEstimated: true,
        metadata: { ...(opts.metadata ?? {}), error: String(e) },
        pricingOverrideRaw: opts.pricingOverrideRaw,
      });
    } catch { /* fail-open absoluto */ }
  }
}
