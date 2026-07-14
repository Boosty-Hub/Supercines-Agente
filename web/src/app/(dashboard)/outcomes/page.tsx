import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell, SectionCard, StatRow, StatCard, EmptyState, Target, TrendUp, Check } from "@/components/ui";
import { GraderRow, NewGraderForm } from "./grader-editor";

export const dynamic = "force-dynamic";

type GraderRowType = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  prompt: string;
  scale: "numeric_0_1" | "pass_fail";
  weight: number;
  enabled: boolean;
  source: "llm_judge" | "automatic" | "manual";
};

type AggRow = {
  grader_id: string;
  grader_slug: string;
  total: number;
  avg_score: number | null;
  passed: number;
};

export default async function OutcomesPage() {
  const supabase = createSupabaseServerClient();

  const { data: graders } = await supabase
    .from("graders")
    .select("id, slug, name, description, prompt, scale, weight, enabled, source")
    .order("slug");

  // Aggregate por grader (últimos 30d)
  const { data: outcomes } = await supabase
    .from("outcomes")
    .select("grader_id, score, passed, graders(slug)")
    .gte("created_at", new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());

  const byGrader = new Map<string, AggRow>();
  for (const o of (outcomes ?? []) as Array<{
    grader_id: string;
    score: number | null;
    passed: boolean | null;
    graders: { slug: string } | { slug: string }[] | null;
  }>) {
    const gv = o.graders;
    const slug = (Array.isArray(gv) ? gv[0]?.slug : gv?.slug) ?? "?";
    const existing = byGrader.get(o.grader_id as string) ?? {
      grader_id: o.grader_id as string,
      grader_slug: slug,
      total: 0,
      avg_score: 0,
      passed: 0,
    };
    existing.total += 1;
    if (typeof o.score === "number") existing.avg_score = (existing.avg_score ?? 0) + Number(o.score);
    if (o.passed === true) existing.passed += 1;
    byGrader.set(o.grader_id as string, existing);
  }
  const aggs = Array.from(byGrader.values()).map((v) => ({
    ...v,
    avg_score: v.total > 0 ? Number(((v.avg_score as number) / v.total).toFixed(3)) : null,
  }));

  const totalEvals = aggs.reduce((s, a) => s + a.total, 0);
  const totalPassed = aggs.reduce((s, a) => s + a.passed, 0);
  const scored = aggs.filter((a) => a.avg_score !== null);
  const overallAvg =
    scored.length > 0
      ? Number(
          (
            scored.reduce((s, a) => s + (a.avg_score as number), 0) / scored.length
          ).toFixed(3),
        )
      : null;
  const overallPassRate =
    totalEvals > 0 ? Math.round((totalPassed / totalEvals) * 100) : null;

  return (
    <PageShell
      title="Evaluaciones"
      description="Graders que evalúan calidad de respuestas. Los cambios afectan las próximas evaluaciones."
    >
      {/* KPI row */}
      <StatRow>
        <StatCard
          label="Evaluaciones (30d)"
          value={totalEvals}
          icon={<Target size={18} />}
          tone="brand"
        />
        <StatCard
          label="Score promedio"
          value={overallAvg !== null ? overallAvg.toFixed(3) : "—"}
          icon={<TrendUp size={18} />}
          tone={overallAvg !== null && overallAvg >= 0.7 ? "emerald" : overallAvg !== null ? "amber" : "default"}
        />
        <StatCard
          label="Tasa de aprobación"
          value={overallPassRate !== null ? `${overallPassRate}%` : "—"}
          icon={<Check size={18} />}
          tone={overallPassRate !== null && overallPassRate >= 70 ? "emerald" : overallPassRate !== null ? "amber" : "default"}
        />
      </StatRow>

      {/* Resumen por grader */}
      <SectionCard title="Resumen últimos 30 días">
        {aggs.length === 0 ? (
          <p className="text-sm text-neutral-600">
            Sin evaluaciones todavía. Una vez que se envíen respuestas, los graders corren automáticamente.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="sticky top-0 bg-neutral-50/60 text-left">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Grader</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Evaluaciones</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Score promedio</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Tasa de aprobación</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {aggs.map((a) => (
                    <tr key={a.grader_id} className="hover:bg-neutral-50/70 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-neutral-700">{a.grader_slug}</td>
                      <td className="px-4 py-3 text-sm text-neutral-600">{a.total}</td>
                      <td className="px-4 py-3 text-sm text-neutral-600">
                        {a.avg_score !== null ? a.avg_score.toFixed(3) : "—"}
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-600">
                        {a.total > 0 ? `${Math.round((a.passed / a.total) * 100)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Graders configurados */}
      <SectionCard
        title="Graders"
        description="Métricas de evaluación configuradas para medir la calidad de las respuestas del agente."
        action={<NewGraderForm />}
      >
        {(graders ?? []).length === 0 ? (
          <EmptyState
            title="Sin graders configurados"
            description="Agregá un grader para empezar a evaluar la calidad de las respuestas."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="sticky top-0 bg-neutral-50/60 text-left">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Identificador</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Nombre</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Escala</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Peso</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Fuente</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Estado</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {(graders ?? []).map((g) => (
                    <GraderRow key={g.id} grader={g as GraderRowType} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </SectionCard>
    </PageShell>
  );
}
