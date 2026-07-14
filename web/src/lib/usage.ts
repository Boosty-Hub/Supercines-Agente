// server-only: importar solo en código server-side (API routes, server components).
// fail-open ABSOLUTO: cualquier error → console.warn, NUNCA propaga.
import { createServiceClient } from "@/lib/supabase/service";
import { configValue } from "@/lib/runtime-config";
import { costUsd, parsePricingOverride } from "@/lib/ai-pricing";

export async function recordWebUsage(p: {
  component: string;
  model: string;
  /** AI SDK v4: usage tiene promptTokens/completionTokens */
  usage: { promptTokens?: number; completionTokens?: number } | undefined;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const override = parsePricingOverride(await configValue("AI_PRICING_OVERRIDES"));
    const cost = costUsd({
      model: p.model,
      inputTokens: p.usage?.promptTokens,
      outputTokens: p.usage?.completionTokens,
      pricingOverride: override,
    });
    await createServiceClient().from("usage_events").insert({
      component: p.component,
      model: p.model,
      input_tokens: p.usage?.promptTokens ?? null,
      output_tokens: p.usage?.completionTokens ?? null,
      is_estimated: false,
      estimated_cost_usd: cost,
      metadata: p.metadata ?? null,
    });
  } catch (e) {
    console.warn("recordWebUsage failed (ignored):", e instanceof Error ? e.message : String(e));
  }
}
