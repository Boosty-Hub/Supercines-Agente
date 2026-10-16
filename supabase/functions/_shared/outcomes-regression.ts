// _shared/outcomes-regression.ts — detector de regresión de graders (alerta outcomes_regression).
//
// Antes comparaba el promedio de las últimas 24 h contra los 7 días previos POR GRADER, sin
// mirar qué modelo juzgó cada fila. Al cambiar GRADER_MODEL (Haiku 4.5 → 5.5, oct-2026) la
// escala del juez se movió entre −0.19 y −0.38 con el MISMO agente: la alerta disparaba una
// «regresión» que era del evaluador. Ahora un grader LLM solo se compara contra outcomes
// del mismo juez (`outcomes.metadata.grader_model`); sin baseline de ese juez con n
// suficiente, no hay alerta. Las filas viejas sin grader_model quedan como juez
// desconocido y no sirven de baseline de nadie. Los graders automáticos no tienen juez.

export const REGRESSION_MIN_SAMPLES = 5;
export const REGRESSION_RATIO = 0.7;

export type OutcomeSample = {
  grader_id: string;
  score: number | null;
  slug?: string | null;
  source?: string | null;
  metadata?: unknown;
};

export type Regression = {
  graderId: string;
  slug: string;
  judge: string;
  recentAvg: number;
  recentCount: number;
  baseAvg: number;
  baseCount: number;
};

/** Juez de una fila: el modelo para los llm_judge, "automatic" para los demás, null si no se sabe. */
export function judgeOf(o: OutcomeSample): string | null {
  if (o.source && o.source !== "llm_judge") return "automatic";
  const m = o.metadata as Record<string, unknown> | null | undefined;
  const model = m && typeof m === "object" ? m.grader_model : undefined;
  return typeof model === "string" && model ? model : null;
}

export function detectRegressions(
  recent: OutcomeSample[],
  baseline: OutcomeSample[],
  opts: { minSamples?: number; ratio?: number } = {},
): Regression[] {
  const minN = opts.minSamples ?? REGRESSION_MIN_SAMPLES;
  const ratio = opts.ratio ?? REGRESSION_RATIO;
  type Agg = { sum: number; count: number; slug: string };
  const agg = (rows: OutcomeSample[]) => {
    const map = new Map<string, Agg>();
    for (const r of rows) {
      if (r.score === null || r.score === undefined || !Number.isFinite(Number(r.score))) continue;
      const judge = judgeOf(r);
      if (!judge) continue;
      const key = `${r.grader_id}\u0000${judge}`;
      const cur = map.get(key) ?? { sum: 0, count: 0, slug: r.slug ?? "?" };
      cur.sum += Number(r.score);
      cur.count += 1;
      map.set(key, cur);
    }
    return map;
  };
  const recentAgg = agg(recent);
  const baseAgg = agg(baseline);
  const out: Regression[] = [];
  for (const [key, r] of recentAgg) {
    if (r.count < minN) continue;
    const b = baseAgg.get(key);
    if (!b || b.count < minN) continue;
    const recentAvg = r.sum / r.count;
    const baseAvg = b.sum / b.count;
    if (recentAvg < ratio * baseAvg) {
      const [graderId, judge] = key.split("\u0000");
      out.push({ graderId, slug: r.slug, judge, recentAvg, recentCount: r.count, baseAvg, baseCount: b.count });
    }
  }
  return out;
}
