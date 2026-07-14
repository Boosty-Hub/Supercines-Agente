// Precios USD por MTok (verificados 2026-06-10). Override por runtime_config.AI_PRICING_OVERRIDES.
// NOTA: contenido idéntico a supabase/functions/_shared/ai-pricing.ts (Deno).
// Mantener en sync. No se comparte archivo: imports Deno vs Node son incompatibles.
export type ModelPricing = {
  input: number; output: number;
  cacheWrite5m: number; cacheWrite1h: number; cacheRead: number;
};
export const AI_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.30 },
  "claude-haiku-4-5":  { input: 1, output: 5,  cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.10 },
  "claude-opus-4-8":   { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.50 },
};
export const CMA_RUNTIME_USD_PER_HOUR = 0.08; // adicional a tokens, sobre active_seconds

export type UsageRow = {
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreation5m?: number | null;
  cacheCreation1h?: number | null;
  cacheReadTokens?: number | null;
  runtimeMs?: number | null;        // CMA only
  pricingOverride?: Record<string, Partial<ModelPricing>> | null;
};

// función ÚNICA de costo. fail-open: modelo desconocido → 0.
export function costUsd(row: UsageRow): number {
  const base = AI_PRICING[row.model];
  const ov = row.pricingOverride?.[row.model];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p: ModelPricing = base ? { ...base, ...(ov ?? {}) } : (ov as ModelPricing | undefined) ?? null as any;
  if (!p) return 0;
  const M = 1_000_000;
  let c = 0;
  c += ((row.inputTokens  ?? 0) / M) * p.input;
  c += ((row.outputTokens ?? 0) / M) * p.output;
  c += ((row.cacheReadTokens ?? 0) / M) * p.cacheRead;
  c += ((row.cacheCreation5m ?? 0) / M) * p.cacheWrite5m;
  c += ((row.cacheCreation1h ?? 0) / M) * p.cacheWrite1h;
  if (row.runtimeMs) c += (row.runtimeMs / 3_600_000) * CMA_RUNTIME_USD_PER_HOUR;
  return Number(c.toFixed(6));
}

// parse override fail-open. NUNCA tira.
export function parsePricingOverride(raw: string | null | undefined): Record<string, Partial<ModelPricing>> | null {
  if (!raw) return null;
  try { const o = JSON.parse(raw); return (o && typeof o === "object") ? o : null; } catch { return null; }
}
