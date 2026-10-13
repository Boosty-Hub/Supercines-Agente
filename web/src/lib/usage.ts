// server-only: importar solo en código server-side (API routes, server components).
// fail-open ABSOLUTO: cualquier error → console.warn, NUNCA propaga.
import { createServiceClient } from "@/lib/supabase/service";
import { configValue } from "@/lib/runtime-config";
import { costUsd, parsePricingOverride } from "@/lib/ai-pricing";

export async function recordWebUsage(p: {
  component: string;
  model: string;
  /** AI SDK v5 (inputTokens/outputTokens); se aceptan también los nombres de v4. */
  usage:
    | { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number }
    | undefined;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const inputTokens = p.usage?.inputTokens ?? p.usage?.promptTokens;
  const outputTokens = p.usage?.outputTokens ?? p.usage?.completionTokens;
  try {
    const override = parsePricingOverride(await configValue("AI_PRICING_OVERRIDES"));
    const cost = costUsd({
      model: p.model,
      inputTokens,
      outputTokens,
      pricingOverride: override,
    });
    await createServiceClient().from("usage_events").insert({
      component: p.component,
      model: p.model,
      input_tokens: inputTokens ?? null,
      output_tokens: outputTokens ?? null,
      is_estimated: false,
      estimated_cost_usd: cost,
      metadata: p.metadata ?? null,
    });
  } catch (e) {
    console.warn("recordWebUsage failed (ignored):", e instanceof Error ? e.message : String(e));
  }
}
