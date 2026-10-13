// Precios USD por MTok (verificados 2026-10-13 contra
// https://platform.claude.com/docs/en/about-claude/pricing).
// Override por runtime_config.AI_PRICING_OVERRIDES.
// NOTA: contenido idéntico a web/src/lib/ai-pricing.ts (Node/Next).
// Mantener en sync. No se comparte archivo: imports Deno vs Node son incompatibles.
// supabase/tests/web-parity.test.ts ASEGURA la paridad (falla si divergen).
export type RateCard = {
  input: number; output: number;
  cacheWrite5m: number; cacheWrite1h: number; cacheRead: number;
};
// Tarifa escalonada por largo de prompt (Haiku 5.5): una REQUEST cuyo prompt
// supera `aboveTokens` paga TODAS sus categorías (input, output, cache read y
// write) a la tarifa larga — no es marginal. El largo del prompt cuenta TODOS
// los tokens de entrada de esa request, incluidos cache reads y cache writes.
export type ModelPricing = RateCard & {
  longContext?: RateCard & { aboveTokens: number };
};
export const AI_PRICING: Record<string, ModelPricing> = {
  "claude-haiku-5-5": {
    input: 0.10, output: 0.50, cacheWrite5m: 0.125, cacheWrite1h: 0.20, cacheRead: 0.01,
    longContext: {
      aboveTokens: 100_000,
      input: 0.50, output: 2.50, cacheWrite5m: 0.625, cacheWrite1h: 1.00, cacheRead: 0.05,
    },
  },
  // Históricos: se conservan para valuar filas viejas de usage_events y para
  // los operadores que aún los tengan asignados.
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
  /**
   * true cuando la fila es un AGREGADO de varias requests (uso total de una
   * sesión CMA): el largo de prompt de cada request interna es desconocido, así
   * que no se puede escoger el escalón y se valúa a la tarifa base (cota
   * inferior). Una llamada directa a la Messages API es UNA request: no se marca.
   */
  aggregated?: boolean;
  pricingOverride?: Record<string, Partial<ModelPricing>> | null;
};

/** Tarifa aplicable a una request con `promptTokens` tokens de entrada. */
export function rateCardFor(p: ModelPricing, promptTokens: number | undefined): RateCard {
  const lc = p.longContext;
  if (lc && promptTokens !== undefined && promptTokens > lc.aboveTokens) return lc;
  return p;
}

// función ÚNICA de costo. fail-open: modelo desconocido → 0.
export function costUsd(row: UsageRow): number {
  const base = AI_PRICING[row.model];
  const ov = row.pricingOverride?.[row.model];
  // deno-lint-ignore no-explicit-any
  const p: ModelPricing = base ? { ...base, ...(ov ?? {}) } : (ov as ModelPricing | undefined) ?? null as any;
  if (!p) return 0;
  const M = 1_000_000;
  const promptTokens = row.aggregated
    ? undefined
    : (row.inputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheCreation5m ?? 0) + (row.cacheCreation1h ?? 0);
  const r = rateCardFor(p, promptTokens);
  let c = 0;
  c += ((row.inputTokens  ?? 0) / M) * r.input;
  c += ((row.outputTokens ?? 0) / M) * r.output;
  c += ((row.cacheReadTokens ?? 0) / M) * r.cacheRead;
  c += ((row.cacheCreation5m ?? 0) / M) * r.cacheWrite5m;
  c += ((row.cacheCreation1h ?? 0) / M) * r.cacheWrite1h;
  if (row.runtimeMs) c += (row.runtimeMs / 3_600_000) * CMA_RUNTIME_USD_PER_HOUR;
  return Number(c.toFixed(6));
}

// parse override fail-open. NUNCA tira.
export function parsePricingOverride(raw: string | null | undefined): Record<string, Partial<ModelPricing>> | null {
  if (!raw) return null;
  try { const o = JSON.parse(raw); return (o && typeof o === "object") ? o : null; } catch { return null; }
}
