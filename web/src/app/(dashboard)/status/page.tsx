import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PageShell, SectionCard, StatRow, StatCard, EmptyState, Badge,
  MessageSquare, Clock, Check, TrendUp, Bell, Sparkles, Wrench,
} from "@/components/ui";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

const ALERT_KIND_LABELS: Record<string, string> = {
  human_review_needed: "Revisión humana solicitada",
  draft_failed: "Respuesta fallida",
  dream_error: "Aprendizaje marcado como error",
  media_processing_failed: "Adjunto no procesado",
  inbound_silence: "Silencio del webhook de Kommo",
  outcomes_regression: "Caída de calidad detectada",
};

type UsageRow = { component: string; calls: number; total_cost_usd: number | null; total_runtime_ms: number | null };
type DraftRow = { status: string };
type OutcomeRow = {
  grader_id: string;
  score: number | null;
  passed: boolean | null;
  graders: { slug: string; name: string } | { slug: string; name: string }[] | null;
};
type AlertRow = { kind: string; title: string; severity: string; created_at: string };

export default async function StatusPage() {
  const supabase = createSupabaseServerClient();
  const cutoffIso = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const cutoffDay = cutoffIso.slice(0, 10);

  const [
    { data: usageDaily },
    { data: draftsRows },
    { data: outcomesRows },
    { data: alertsRows },
    { count: inboundCount },
    { count: routedCount },
  ] = await Promise.all([
    supabase.from("usage_daily").select("component, calls, total_cost_usd, total_runtime_ms").gte("day", cutoffDay),
    supabase.from("drafts").select("status").gte("created_at", cutoffIso),
    supabase.from("outcomes").select("grader_id, score, passed, graders(slug, name)").gte("created_at", cutoffIso),
    supabase.from("alerts").select("kind, title, severity, created_at").gte("created_at", cutoffIso).order("created_at", { ascending: false }),
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("direction", "inbound").gte("created_at", cutoffIso),
    supabase.from("leads").select("id", { count: "exact", head: true }).not("routed_at", "is", null).gte("routed_at", cutoffIso),
  ]);

  // --- Volumen, tiempos y costo ---
  const usage = (usageDaily ?? []) as UsageRow[];
  const totalCost = usage.reduce((s, r) => s + Number(r.total_cost_usd ?? 0), 0);
  const genRows = usage.filter((r) => r.component === "generate_response");
  const genCalls = genRows.reduce((s, r) => s + Number(r.calls ?? 0), 0);
  const genRuntime = genRows.reduce((s, r) => s + Number(r.total_runtime_ms ?? 0), 0);
  const avgRuntimeSec = genCalls > 0 ? Math.round(genRuntime / genCalls / 1000) : null;

  // --- Respuestas ---
  const drafts = (draftsRows ?? []) as DraftRow[];
  const statusCounts = new Map<string, number>();
  for (const d of drafts) statusCounts.set(d.status, (statusCounts.get(d.status) ?? 0) + 1);
  const sent = (statusCounts.get("auto_sent") ?? 0) + (statusCounts.get("sent") ?? 0) + (statusCounts.get("approved") ?? 0);
  const failed = statusCounts.get("failed") ?? 0;
  const pending = statusCounts.get("pending") ?? 0;
  const totalDrafts = sent + failed + pending;
  const successRate = totalDrafts > 0 ? Math.round((sent / totalDrafts) * 100) : null;

  // --- Aciertos por evaluador (mismo cálculo que /outcomes) ---
  type GraderAgg = { grader_id: string; slug: string; name: string; total: number; scoreSum: number; passed: number };
  const byGrader = new Map<string, GraderAgg>();
  for (const o of (outcomesRows ?? []) as OutcomeRow[]) {
    const gv = o.graders;
    const g = Array.isArray(gv) ? gv[0] : gv;
    const slug = g?.slug ?? "?";
    const name = g?.name ?? slug;
    const existing = byGrader.get(o.grader_id) ?? { grader_id: o.grader_id, slug, name, total: 0, scoreSum: 0, passed: 0 };
    existing.total += 1;
    if (typeof o.score === "number") existing.scoreSum += Number(o.score);
    if (o.passed === true) existing.passed += 1;
    byGrader.set(o.grader_id, existing);
  }
  const graderAggs = Array.from(byGrader.values()).map((v) => ({
    ...v,
    avgScore: v.total > 0 ? v.scoreSum / v.total : null,
    passRate: v.total > 0 ? Math.round((v.passed / v.total) * 100) : null,
  }));
  const totalOutcomeEvals = graderAggs.reduce((s, a) => s + a.total, 0);
  const totalOutcomePassed = graderAggs.reduce((s, a) => s + a.passed, 0);
  const overallPassRate = totalOutcomeEvals > 0 ? Math.round((totalOutcomePassed / totalOutcomeEvals) * 100) : null;

  // --- Oportunidades de mejora (alertas) ---
  const alerts = (alertsRows ?? []) as AlertRow[];
  const alertsByKind = new Map<string, number>();
  for (const a of alerts) alertsByKind.set(a.kind, (alertsByKind.get(a.kind) ?? 0) + 1);
  const alertKindRows = Array.from(alertsByKind.entries()).sort((a, b) => b[1] - a[1]);
  const recentAlerts = alerts.slice(0, 8);

  // --- Logros (curado, no solo repetir los stat cards) ---
  const achievements: string[] = [];
  if ((inboundCount ?? 0) > 0) {
    achievements.push(
      `${inboundCount} mensajes atendidos en los últimos ${WINDOW_DAYS} días — ${sent} respondidos automáticamente por el agente${successRate !== null ? ` (${successRate}% de tasa de envío exitoso)` : ""}.`
    );
  }
  if (overallPassRate !== null) {
    achievements.push(
      `${overallPassRate}% de aprobación general en las evaluaciones automáticas de calidad, sobre ${totalOutcomeEvals} evaluaciones.`
    );
  }
  if ((routedCount ?? 0) > 0) {
    achievements.push(
      `${routedCount} leads ruteados automáticamente al vendedor o sede correcta, sin intervención manual.`
    );
  }
  if (avgRuntimeSec !== null) {
    achievements.push(`Tiempo promedio de respuesta del agente: ${avgRuntimeSec}s.`);
  }

  // --- Optimizaciones y recomendaciones (lectura de las métricas de arriba, no una lista de alertas cruda) ---
  type Recommendation = { severity: "warning" | "info" | "ok"; title: string; detail: string };
  const recommendations: Recommendation[] = [];

  if (successRate !== null && successRate < 90) {
    recommendations.push({
      severity: "warning",
      title: `Tasa de envío exitoso en ${successRate}% (meta: ≥90%)`,
      detail: `${failed} respuesta(s) fallida(s) y ${pending} pendiente(s) de revisión en el período — revisar el Inbox para destrabarlas.`,
    });
  }

  const worstGrader = graderAggs.length > 0
    ? graderAggs.reduce((worst, g) => ((g.passRate ?? Infinity) < (worst.passRate ?? Infinity) ? g : worst))
    : null;
  if (overallPassRate !== null && overallPassRate < 85 && worstGrader && worstGrader.passRate !== null) {
    recommendations.push({
      severity: "warning",
      title: `Aprobación de calidad general en ${overallPassRate}% (meta: ≥85%)`,
      detail: `El evaluador con peor desempeño es "${worstGrader.name}" (${worstGrader.passRate}% de aprobación) — revisar en /outcomes qué está fallando.`,
    });
  }

  if (avgRuntimeSec !== null && avgRuntimeSec > 90) {
    recommendations.push({
      severity: "info",
      title: `Tiempo promedio de respuesta: ${avgRuntimeSec}s`,
      detail: "Si se mantiene alto, conviene revisar la cantidad de tool calls o el tamaño del contexto del agente en /agent.",
    });
  }

  const dreamErrorCount = alertsByKind.get("dream_error") ?? 0;
  if (dreamErrorCount > 0) {
    recommendations.push({
      severity: "warning",
      title: `${dreamErrorCount} aprendizaje(s) marcado(s) como error`,
      detail: "Mientras no se revisen pueden estar generando respuestas incorrectas — revisar en /dreams.",
    });
  }

  if (pending > 0) {
    recommendations.push({
      severity: "info",
      title: `${pending} respuesta(s) esperando revisión humana`,
      detail: "Revisarlas en el Inbox para no perder el hilo con esos leads.",
    });
  }

  if (recommendations.length === 0 && totalDrafts > 0) {
    recommendations.push({
      severity: "ok",
      title: "Sin problemas detectados en este período",
      detail: "Tasa de envío, calidad y tiempos de respuesta dentro de los parámetros esperados.",
    });
  }

  const severityBadge = {
    warning: { color: "amber" as const, label: "Atender" },
    info: { color: "blue" as const, label: "Sugerencia" },
    ok: { color: "green" as const, label: "OK" },
  };

  return (
    <PageShell
      title="Status del agente"
      description={`Resumen de actividad de los últimos ${WINDOW_DAYS} días — logros, respuestas, tiempos, aciertos, oportunidades de mejora y optimizaciones y recomendaciones.`}
    >
      <StatRow>
        <StatCard
          label="Mensajes atendidos"
          value={inboundCount ?? 0}
          icon={<MessageSquare size={18} />}
          tone="brand"
        />
        <StatCard
          label="Tiempo promedio de respuesta"
          value={avgRuntimeSec !== null ? `${avgRuntimeSec}s` : "—"}
          icon={<Clock size={18} />}
        />
        <StatCard
          label="Tasa de envío exitoso"
          value={successRate !== null ? `${successRate}%` : "—"}
          icon={<Check size={18} />}
          tone={successRate !== null && successRate >= 90 ? "emerald" : successRate !== null ? "amber" : "default"}
        />
        <StatCard
          label={`Costo (${WINDOW_DAYS}d)`}
          value={`$${totalCost.toFixed(2)}`}
          icon={<TrendUp size={18} />}
        />
      </StatRow>

      <SectionCard
        icon={<Sparkles size={18} />}
        title="Logros"
        description="Lo más destacado de la actividad del agente en el período."
      >
        {achievements.length === 0 ? (
          <EmptyState
            title="Sin actividad suficiente"
            description="No hay datos suficientes en este período para reportar logros."
          />
        ) : (
          <ul className="space-y-2">
            {achievements.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-neutral-700">
                <Check size={16} className="mt-0.5 shrink-0 text-emerald-600" />
                <span>{a}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Respuestas"
        description="Qué pasó con los mensajes que el agente intentó responder en el período."
      >
        {totalDrafts === 0 ? (
          <p className="text-sm text-neutral-600">Sin actividad registrada en este período.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-neutral-200 p-3">
              <p className="text-xs text-neutral-500">Enviadas</p>
              <p className="mt-1 text-lg font-semibold text-neutral-900 tabular-nums">{sent}</p>
            </div>
            <div className="rounded-lg border border-neutral-200 p-3">
              <p className="text-xs text-neutral-500">Fallidas</p>
              <p className="mt-1 text-lg font-semibold text-neutral-900 tabular-nums">{failed}</p>
            </div>
            <div className="rounded-lg border border-neutral-200 p-3">
              <p className="text-xs text-neutral-500">Pendientes de revisión</p>
              <p className="mt-1 text-lg font-semibold text-neutral-900 tabular-nums">{pending}</p>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Aciertos por evaluador"
        description="Score promedio y tasa de aprobación de cada evaluador automático de calidad."
      >
        {graderAggs.length === 0 ? (
          <EmptyState
            title="Sin evaluaciones en este período"
            description="Los evaluadores corren automáticamente sobre las respuestas enviadas."
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-neutral-200 p-3">
                <p className="text-xs text-neutral-500">Evaluaciones totales</p>
                <p className="mt-1 text-lg font-semibold text-neutral-900 tabular-nums">{totalOutcomeEvals}</p>
              </div>
              <div className="rounded-lg border border-neutral-200 p-3">
                <p className="text-xs text-neutral-500">Tasa de aprobación general</p>
                <p className="mt-1 text-lg font-semibold text-neutral-900 tabular-nums">
                  {overallPassRate !== null ? `${overallPassRate}%` : "—"}
                </p>
              </div>
            </div>
            <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[560px]">
                  <thead className="bg-neutral-50/60 text-left">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Evaluador</th>
                      <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Evaluaciones</th>
                      <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Score promedio</th>
                      <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Tasa de aprobación</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {graderAggs.map((a) => (
                      <tr key={a.grader_id}>
                        <td className="px-4 py-3 text-sm text-neutral-700">{a.name}</td>
                        <td className="px-4 py-3 text-sm text-neutral-600">{a.total}</td>
                        <td className="px-4 py-3 text-sm text-neutral-600">
                          {a.avgScore !== null ? a.avgScore.toFixed(2) : "—"}
                        </td>
                        <td className="px-4 py-3 text-sm text-neutral-600">
                          {a.passRate !== null ? `${a.passRate}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard
        icon={<Bell size={18} />}
        title="Oportunidades de mejora"
        description="Alertas registradas en el período — errores recurrentes y casos que requirieron intervención humana."
      >
        {alerts.length === 0 ? (
          <EmptyState
            title="Sin alertas en este período"
            description="No se registraron errores ni revisiones pendientes."
          />
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {alertKindRows.map(([kind, count]) => (
                <span
                  key={kind}
                  className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700"
                >
                  {ALERT_KIND_LABELS[kind] ?? kind}
                  <span className="font-semibold tabular-nums">{count}</span>
                </span>
              ))}
            </div>
            <div className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 bg-white">
              {recentAlerts.map((a, i) => (
                <div key={i} className="px-4 py-3">
                  <p className="text-sm text-neutral-800">{a.title}</p>
                  <p className="mt-0.5 text-xs text-neutral-400">
                    {ALERT_KIND_LABELS[a.kind] ?? a.kind} · {new Date(a.created_at).toLocaleString("es-VE")}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard
        icon={<Wrench size={18} />}
        title="Optimizaciones y recomendaciones"
        description="Lectura de las métricas de arriba traducida en próximos pasos concretos."
      >
        {recommendations.length === 0 ? (
          <EmptyState
            title="Sin datos suficientes"
            description="No hay actividad suficiente en este período para generar recomendaciones."
          />
        ) : (
          <ul className="space-y-3">
            {recommendations.map((r, i) => (
              <li key={i} className="rounded-lg border border-neutral-200 p-3">
                <div className="flex items-center gap-2">
                  <Badge color={severityBadge[r.severity].color} variant="ring">
                    {severityBadge[r.severity].label}
                  </Badge>
                  <p className="text-sm font-medium text-neutral-900">{r.title}</p>
                </div>
                <p className="mt-1 text-xs text-neutral-500">{r.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </PageShell>
  );
}
