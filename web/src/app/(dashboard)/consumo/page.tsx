import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PageShell, StatRow, StatCard, SectionCard, EmptyState, BarChart3, TrendUp,
} from "@/components/ui";
import { LineAreaChart, BarBreakdown, HeatmapGrid, type LineAreaSeries } from "./charts";
import { BackfillBanner } from "./BackfillBanner";
import { BillingFlow, type BillingPoint } from "./billing-flow";
import { CostCalculator, type CalculatorData, type TokenProfile } from "./cost-calculator";
import { ModelsPanel } from "./models-panel";
import { ContextPanel } from "./context-panel";
import { configValues } from "@/lib/runtime-config";
import { MODEL_KEYS } from "@/lib/model-config";
import { AI_PRICING, CMA_RUNTIME_USD_PER_HOUR } from "@/lib/ai-pricing";

export const dynamic = "force-dynamic";


// Nombres humanos de cada componente (el operador no habla en snake_case).
const COMPONENT_LABELS: Record<string, string> = {
  generate_response: "Respuestas",
  classify: "Clasificación",
  dreams: "Dreams",
  grader: "Evaluaciones",
  follow_up: "Seguimiento",
  comment_reply: "Comentarios (pública)",
};
function componentLabel(c: string): string {
  if (COMPONENT_LABELS[c]) return COMPONENT_LABELS[c];
  if (c.startsWith("dashboard_")) return "IA del dashboard";
  return c.replace(/_/g, " ");
}

// ---- Umbrales de palancas ----
const OPT_A_THRESHOLD = 0.20; // cache hit ratio < 20% → palanca
const OPT_C_THRESHOLD_MS = 90_000; // avg runtime >90s
const OPT_D_THRESHOLD = 0.10; // dashboard_* > 10% del costo total

// ---- Helpers ----
function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

type DailyRow = {
  day: string;
  component: string;
  model: string;
  calls: number;
  total_input: number | null;
  total_output: number | null;
  total_cache_read: number | null;
  total_cache_creation: number | null;
  total_cost_usd: number | null;
  total_runtime_ms: number | null;
  has_estimates: boolean;
};

type HeatmapRow = {
  dow: number;
  hour: number;
  calls: number;
  cost_usd: number | null;
};

export default async function ConsumoPage({
  searchParams,
}: {
  searchParams: { range?: string };
}) {
  const range = parseInt(searchParams.range ?? "30", 10);
  const validRange = [7, 30, 90].includes(range) ? range : 30;
  const since = new Date(Date.now() - validRange * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const supabase = createSupabaseServerClient();

  // Timezone del negocio (default America/Guayaquil)
  const { data: tzRow } = await supabase
    .from("follow_up_config")
    .select("timezone")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  const tz = tzRow?.timezone ?? "America/Guayaquil";

  // usage_daily para el rango
  const { data: dailyRaw } = await supabase
    .from("usage_daily")
    .select("day, component, model, calls, total_input, total_output, total_cache_read, total_cache_creation, total_cost_usd, total_runtime_ms, has_estimates")
    .gte("day", since)
    .order("day", { ascending: true });

  const daily = (dailyRaw ?? []) as DailyRow[];

  // usage_hourly_heatmap (completo, TZ ya aplicada en SQL)
  const { data: heatmapRaw } = await supabase
    .from("usage_hourly_heatmap")
    .select("dow, hour, calls, cost_usd");
  const heatmap = (heatmapRaw ?? []) as HeatmapRow[];

  // Backfill detection: drafts con session_id pero sin usage generate_response
  const { count: draftsWithSession } = await supabase
    .from("drafts")
    .select("id", { count: "exact", head: true })
    .not("agent_metadata->session_id", "is", null);

  const { count: usageGenResp } = await supabase
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("component", "generate_response");

  const showBackfillBanner = (draftsWithSession ?? 0) > (usageGenResp ?? 0);

  // ---- EmptyState ----
  if (daily.length === 0 && heatmap.length === 0) {
    return (
      <PageShell title="Consumo" description="Gasto estimado del agente — tokens, runtime y costo por componente.">
        {showBackfillBanner && <BackfillBanner />}
        <EmptyState
          title="Sin datos de consumo aún"
          description="Los datos aparecen cuando el agente procesa mensajes. Si ya hay sesiones históricas, importálas con el botón de arriba."
        />
      </PageShell>
    );
  }

  // ---- KPIs ----
  const totalCost = daily.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0);
  const totalCalls = daily.reduce((s, r) => s + r.calls, 0);
  const totalTokens = daily.reduce((s, r) => s + (r.total_input ?? 0) + (r.total_output ?? 0), 0);
  const hasEstimates = daily.some((r) => r.has_estimates);

  const genRespRows = daily.filter((r) => r.component === "generate_response");
  const genRespCost = genRespRows.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0);
  const genRespCalls = genRespRows.reduce((s, r) => s + r.calls, 0);
  const avgCostPerResp = genRespCalls > 0 ? genRespCost / genRespCalls : 0;

  // ---- Line chart series ----
  const allDays = Array.from(new Set(daily.map((r) => r.day))).sort();
  const components = Array.from(new Set(daily.map((r) => r.component)));
  const COLORS: Record<string, string> = {
    generate_response: "#6366f1",
    classify:          "#f59e0b",
    dreams:            "#10b981",
    grader:            "#8b5cf6",
  };

  const series: LineAreaSeries[] = components.map((comp) => ({
    label: componentLabel(comp),
    color: COLORS[comp] ?? "#94a3b8",
    values: allDays.map((d) => {
      const row = daily.find((r) => r.day === d && r.component === comp);
      return row?.total_cost_usd ?? 0;
    }),
  }));

  // ---- BarBreakdown por componente ----
  const componentTotals = components
    .map((comp) => ({
      label: componentLabel(comp),
      value: daily.filter((r) => r.component === comp).reduce((s, r) => s + (r.total_cost_usd ?? 0), 0),
      estimated: daily.filter((r) => r.component === comp).some((r) => r.has_estimates),
    }))
    .sort((a, b) => b.value - a.value);

  // BarBreakdown por modelo
  const models = Array.from(new Set(daily.map((r) => r.model)));
  const modelTotals = models
    .map((m) => ({
      label: m,
      value: daily.filter((r) => r.model === m).reduce((s, r) => s + (r.total_cost_usd ?? 0), 0),
    }))
    .sort((a, b) => b.value - a.value);

  // ---- Heatmap: convertir TZ (la vista ya lo hace en SQL para el heatmap view) ----
  const heatmapCells = heatmap.map((r) => ({
    dow: r.dow,
    hour: r.hour,
    value: r.cost_usd ?? 0,
  }));
  const heatmapMax = Math.max(...heatmapCells.map((c) => c.value), 0.001);

  // ---- Palancas de optimización ----
  type Palanca = { id: string; title: string; description: string; recommendation: string };
  const palancas: Palanca[] = [];

  // OPT-A: cache hit ratio < 20% → sugerir mejorar caching
  // Usando total_cache_read como proxy de cache efficiency
  const genRespCacheRead = daily
    .filter((r) => r.component === "generate_response")
    .reduce((s, r) => s + (r.total_cache_read ?? 0), 0);
  const genRespInput = daily
    .filter((r) => r.component === "generate_response")
    .reduce((s, r) => s + (r.total_input ?? 0), 0);
  if (genRespInput > 0) {
    const cacheHitRatio = genRespCacheRead / genRespInput;
    if (cacheHitRatio < OPT_A_THRESHOLD) {
      palancas.push({
        id: "OPT-A",
        title: "Caché CMA bajo",
        description: `El prompt caching está infrautilizado (${(cacheHitRatio * 100).toFixed(1)}% de hits sobre inputs). El caching reduce el costo de input entre 70-90%.`,
        recommendation: "Estabilizá el system prompt y el orden de los memory stores. Evitá contenido dinámico en la cabeza del contexto.",
      });
    }
  }

  // OPT-B: generate_response > 70% del costo total (umbral fijo 0.70)
  if (totalCost > 0 && genRespCost / totalCost > 0.70) {
    palancas.push({
      id: "OPT-B",
      title: "Las respuestas dominan el gasto",
      description: `Las respuestas CMA concentran el ${((genRespCost / totalCost) * 100).toFixed(0)}% del gasto (${formatUsd(genRespCost)} de ${formatUsd(totalCost)}).`,
      recommendation: "Revisá la cantidad máxima de tool calls por sesión y la longitud del system prompt. Cada herramienta extra suma tokens y tiempo facturable.",
    });
  }

  // OPT-C: runtime promedio > 90s
  const genRespRuntimeMs = daily
    .filter((r) => r.component === "generate_response")
    .reduce((s, r) => s + (r.total_runtime_ms ?? 0), 0);
  if (genRespCalls > 0) {
    const avgRuntimeMs = genRespRuntimeMs / genRespCalls;
    if (avgRuntimeMs > OPT_C_THRESHOLD_MS) {
      palancas.push({
        id: "OPT-C",
        title: "Runtime alto por sesión",
        description: `Las sesiones promedian ${(avgRuntimeMs / 1000).toFixed(0)}s activos. El runtime facturable es $0.08/hora sobre active_seconds.`,
        recommendation: "Revisá tools lentas, loops del agente o prompts que generan muchas iteraciones. Reducir el p90 de active_seconds baja el costo de runtime directamente.",
      });
    }
  }

  // OPT-E: la ESCRITURA de caché pesa demasiado → evaluar caché 1h / prefijo estable.
  // Con sesiones espaciadas >5 min, cada una re-escribe el caché completo.
  const genRespCacheWrite = daily
    .filter((r) => r.component === "generate_response")
    .reduce((s, r) => s + (r.total_cache_creation ?? 0), 0);
  if (genRespCost > 0 && genRespCacheWrite > 0) {
    // Aproximación con tarifa write-5m de Sonnet ($3.75/MTok) — es la dominante.
    const cacheWriteUsd = (genRespCacheWrite / 1_000_000) * 3.75;
    const writeShare = cacheWriteUsd / genRespCost;
    if (writeShare > 0.30) {
      palancas.push({
        id: "OPT-E",
        title: "Leer el material por primera vez domina el costo de respuestas",
        description: `La 'primera leída' del material de cada sesión cuesta ≈${formatUsd(cacheWriteUsd)} (${(writeShare * 100).toFixed(0)}% del costo de respuestas). Cada respuesta arranca leyendo TODO: reglas, memoria del lead, dreams y la conversación.`,
        recommendation: "Anthropic no permite abaratar esa primera leída en este tipo de sesiones (el descuento de 1 hora no aplica acá). La palanca real es darle MENOS material a leer: memoria por lead recortada y prompt magro — cada KB menos se deja de leer y repasar en todas las sesiones del día.",
      });
    }
  }

  // OPT-D: dashboard_* > 10% del costo total
  const dashCost = daily
    .filter((r) => r.component.startsWith("dashboard_"))
    .reduce((s, r) => s + (r.total_cost_usd ?? 0), 0);
  if (totalCost > 0 && dashCost / totalCost > OPT_D_THRESHOLD) {
    palancas.push({
      id: "OPT-D",
      title: "Generaciones de dashboard con peso significativo",
      description: `Las herramientas IA del dashboard suman el ${((dashCost / totalCost) * 100).toFixed(1)}% del gasto total (${formatUsd(dashCost)}).`,
      recommendation: "Considerá cachear sugerencias de verticales/graders, o reducir la frecuencia de uso de generaciones asistidas.",
    });
  }

  // ---- Modelos por componente (DB-first, default = diseño del pipeline) ----
  const modelCfg = await configValues(Object.keys(MODEL_KEYS));
  const currentModels: Record<string, string> = {};
  for (const [key, def] of Object.entries(MODEL_KEYS)) {
    currentModels[key] = modelCfg[key] || def;
  }

  // ---- Unitarios reales por componente (para flujo + calculadora) ----
  const compStats = (comp: string) => {
    const rows = daily.filter((r) => r.component === comp);
    const cost = rows.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0);
    const calls = rows.reduce((s, r) => s + r.calls, 0);
    return { cost, calls, avg: calls > 0 ? cost / calls : null };
  };
  // Perfil de TOKENS promedio por evento — lo que consume cada componente,
  // independiente del modelo. La calculadora le pone precio según el modelo
  // asignado (o simulado), así cambiar de modelo recalcula al instante.
  const tokenProfile = (comp: string): TokenProfile | null => {
    const rows = daily.filter((r) => r.component === comp);
    const calls = rows.reduce((s, r) => s + r.calls, 0);
    if (calls === 0) return null;
    return {
      inTok: rows.reduce((s, r) => s + (r.total_input ?? 0), 0) / calls,
      outTok: rows.reduce((s, r) => s + (r.total_output ?? 0), 0) / calls,
      crTok: rows.reduce((s, r) => s + (r.total_cache_read ?? 0), 0) / calls,
      cwTok: rows.reduce((s, r) => s + (r.total_cache_creation ?? 0), 0) / calls,
      runtimeMs: rows.reduce((s, r) => s + (r.total_runtime_ms ?? 0), 0) / calls,
    };
  };
  const sClassify = compStats("classify");
  const sResp = compStats("generate_response");
  const sComment = compStats("comment_reply");
  const sGrader = compStats("grader");
  const sDreams = compStats("dreams");
  const sFollow = compStats("follow_up");
  const share = (c: number) => (totalCost > 0 ? (c / totalCost) * 100 : 0);

  // Con qué modelos se midió realmente el período (puede mezclar: ayer Sonnet,
  // hoy Haiku). Si difiere del modelo configurado AHORA, lo aclaramos en el
  // flujo — el promedio es histórico real, el badge es el modelo de acá en más.
  const MODEL_SHORT: Record<string, string> = {
    "claude-haiku-4-5": "Haiku 4.5",
    "claude-sonnet-4-6": "Sonnet 4.6",
    "claude-opus-4-8": "Opus 4.8",
  };
  const measuredWith = (comp: string, configured: string): string | undefined => {
    const rows = daily.filter((r) => r.component === comp);
    const byModel = new Map<string, number>();
    for (const r of rows) byModel.set(r.model, (byModel.get(r.model) ?? 0) + (r.total_cost_usd ?? 0));
    const total = Array.from(byModel.values()).reduce((s, v) => s + v, 0);
    if (total <= 0) return undefined;
    const entries = Array.from(byModel.entries()).sort((a, b) => b[1] - a[1]);
    // Si todo el período corrió con el modelo configurado, no hay nada que aclarar.
    if (entries.length === 1 && entries[0][0] === configured) return undefined;
    return (
      "promedio medido con " +
      entries
        .map(([m, c]) => `${MODEL_SHORT[m] ?? m} (${((c / total) * 100).toFixed(0)}%)`)
        .join(" + ")
    );
  };

  // Desglose EXACTO del costo de respuestas por tipo (cada fila se valora con
  // el modelo que realmente corrió). Responde "¿cuánto es caché vs output?".
  const respType = { cacheWrite: 0, output: 0, cacheRead: 0, input: 0, runtime: 0 };
  for (const r of genRespRows) {
    const pr = AI_PRICING[r.model];
    if (!pr) continue;
    const M = 1_000_000;
    respType.input += ((r.total_input ?? 0) / M) * pr.input;
    respType.output += ((r.total_output ?? 0) / M) * pr.output;
    respType.cacheRead += ((r.total_cache_read ?? 0) / M) * pr.cacheRead;
    respType.cacheWrite += ((r.total_cache_creation ?? 0) / M) * pr.cacheWrite5m;
    respType.runtime += ((r.total_runtime_ms ?? 0) / 3_600_000) * CMA_RUNTIME_USD_PER_HOUR;
  }
  const respBreakdown = [
    { label: "Leer su material por primera vez (lo deja anotado, +25%)", usd: respType.cacheWrite },
    { label: "Repasar lo anotado en cada paso (al 10% del precio)", usd: respType.cacheRead },
    { label: "Pensar y escribir la respuesta", usd: respType.output },
    { label: "El mensaje del cliente", usd: respType.input },
    { label: "Tiempo de trabajo ($0.08 por hora activa)", usd: respType.runtime },
  ].sort((a, b) => b.usd - a.usd);

  const billingPoints: BillingPoint[] = [
    {
      key: "webhook", emoji: "📨", title: "Llega un mensaje (Kommo → webhook)",
      model: null, charges: "Recibirlo y guardarlo no cuesta nada de IA.",
      avgCost: null, unit: "", calls: 0, share: 0,
    },
    {
      key: "classify", emoji: "🏷️", title: "1º cobro — Clasificación del mensaje",
      model: currentModels.CLASSIFY_MODEL,
      charges: "Se cobra input (el mensaje + las verticales) y output (la clasificación). Una vez por mensaje entrante.",
      avgCost: sClassify.avg, unit: "por mensaje", calls: sClassify.calls, share: share(sClassify.cost),
      measuredWith: measuredWith("classify", currentModels.CLASSIFY_MODEL),
    },
    {
      key: "generate_response", emoji: "💬", title: "2º cobro — Respuesta del agente (sesión CMA)",
      model: currentModels.AGENT_MODEL,
      charges: "Antes de responder, el agente LEE todo su material (reglas, memoria del lead, dreams, la conversación) y después PIENSA y ESCRIBE la respuesta. Acá vive casi todo el gasto.",
      avgCost: sResp.avg, unit: "por respuesta", calls: sResp.calls, share: share(sResp.cost),
      measuredWith: measuredWith("generate_response", currentModels.AGENT_MODEL),
      note: "el debounce de 45s agrupa varios mensajes en UNA respuesta",
      breakdown: respBreakdown,
    },
    {
      key: "comment_reply", emoji: "📣", title: "Cobro opcional — Respuesta pública a comentario",
      model: currentModels.COMMENT_REPLY_MODEL,
      charges: "Solo si el mensaje vino de un comentario de Instagram y la respuesta pública está encendida.",
      avgCost: sComment.avg, unit: "por comentario", calls: sComment.calls, share: share(sComment.cost),
      measuredWith: measuredWith("comment_reply", currentModels.COMMENT_REPLY_MODEL),
    },
    {
      key: "grader", emoji: "✅", title: "3º cobro — Evaluación de calidad (graders)",
      model: currentModels.GRADER_MODEL,
      charges: "Cada respuesta enviada se evalúa con los graders activos (uno por grader).",
      avgCost: sGrader.avg, unit: "por evaluación", calls: sGrader.calls, share: share(sGrader.cost),
      measuredWith: measuredWith("grader", currentModels.GRADER_MODEL),
    },
    {
      key: "follow_up", emoji: "🔁", title: "Cobro opcional — Seguimiento a leads fríos",
      model: currentModels.AGENT_MODEL,
      charges: "Sesión CMA igual a una respuesta, disparada por inactividad del lead (si el follow-up está activo).",
      avgCost: sFollow.avg, unit: "por seguimiento", calls: sFollow.calls, share: share(sFollow.cost),
      measuredWith: measuredWith("follow_up", currentModels.AGENT_MODEL),
    },
    {
      key: "dreams", emoji: "🌙", title: "4º cobro — Dreams (aprendizaje nocturno)",
      model: currentModels.DREAMS_MODEL,
      charges: "Analiza las conversaciones del día (1 corrida diaria + 1 semanal) y destila aprendizajes. Costo fijo: no crece con el volumen de mensajes.",
      avgCost: sDreams.avg, unit: "por corrida", calls: sDreams.calls, share: share(sDreams.cost),
      measuredWith: measuredWith("dreams", currentModels.DREAMS_MODEL),
    },
  ];

  // ---- Datos para la calculadora: perfiles de tokens + modelos asignados ----
  const dayCount = Math.max(1, allDays.length);
  // Sin datos medidos, perfiles representativos del pipeline (clasificación
  // corta; sesión CMA con memoria montada y ~80s de runtime).
  const DEFAULT_CLASSIFY: TokenProfile = { inTok: 1500, outTok: 120, crTok: 0, cwTok: 0, runtimeMs: 0 };
  const DEFAULT_RESPONSE: TokenProfile = { inTok: 10, outTok: 2100, crTok: 100_000, cwTok: 15_000, runtimeMs: 80_000 };
  const calculatorData: CalculatorData = {
    profiles: {
      classify: tokenProfile("classify") ?? DEFAULT_CLASSIFY,
      response: tokenProfile("generate_response") ?? DEFAULT_RESPONSE,
      grader: tokenProfile("grader"),
      dreams: tokenProfile("dreams"),
    },
    models: {
      classify: currentModels.CLASSIFY_MODEL,
      response: currentModels.AGENT_MODEL,
      grader: currentModels.GRADER_MODEL,
      dreams: currentModels.DREAMS_MODEL,
    },
    // respuestas / mensajes: el debounce agrupa (< 1). Sin datos: 0.85.
    sessionsPerMsg: sClassify.calls > 0 && sResp.calls > 0 ? Math.min(1, sResp.calls / sClassify.calls) : 0.85,
    gradersPerSession: sResp.calls > 0 ? sGrader.calls / sResp.calls : 0,
    dreamsRunsPerDay: sDreams.calls / dayCount,
  };

  // Range selector
  const ranges = [7, 30, 90];

  return (
    <PageShell
      title="Consumo"
      description="Gasto estimado del agente — tokens, runtime y costo por componente."
      toolbar={
        <div className="flex items-center gap-1.5">
          {ranges.map((r) => (
            <a
              key={r}
              href={`/consumo?range=${r}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                r === validRange
                  ? "bg-neutral-900 text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
            >
              {r}d
            </a>
          ))}
        </div>
      }
    >
      {showBackfillBanner && <BackfillBanner />}

      {/* KPIs */}
      <StatRow>
        <StatCard
          label={`Costo ${validRange}d${hasEstimates ? " *" : ""}`}
          value={formatUsd(totalCost)}
          hint={hasEstimates ? "* incluye estimados" : undefined}
          icon={<TrendUp size={17} />}
          tone="brand"
        />
        <StatCard
          label="Llamadas totales"
          value={totalCalls.toLocaleString()}
          hint={`${validRange} días`}
          icon={<BarChart3 size={17} />}
        />
        <StatCard
          label="Tokens totales"
          value={formatTokens(totalTokens)}
          hint="input + output"
        />
        <StatCard
          label="Avg costo / respuesta"
          value={formatUsd(avgCostPerResp)}
          hint={`${genRespCalls} sesiones CMA`}
          tone={avgCostPerResp > 0.10 ? "amber" : "default"}
        />
      </StatRow>

      {/* Line chart */}
      <SectionCard icon={<TrendUp size={17} />} title="Costo por día" description="USD estimado acumulado por componente">
        <LineAreaChart days={allDays} series={series} formatY={formatUsd} />
      </SectionCard>

      {/* Bar breakdown por componente y modelo */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SectionCard icon={<BarChart3 size={17} />} title="Por componente" description="Costo total en el período">
          <BarBreakdown rows={componentTotals} formatValue={formatUsd} />
        </SectionCard>
        <SectionCard icon={<BarChart3 size={17} />} title="Por modelo" description="Costo total en el período">
          <BarBreakdown rows={modelTotals} formatValue={formatUsd} />
        </SectionCard>
      </div>

      {/* El recorrido del dinero: cada punto donde Anthropic cobra */}
      <SectionCard
        icon={<TrendUp size={17} />}
        title="¿Dónde cobra Claude? — el recorrido del dinero"
        description="Cada punto del flujo donde hay un cobro, con el modelo configurado y el costo promedio real del período"
      >
        <BillingFlow points={billingPoints} />
      </SectionCard>

      {/* Composición del contexto: qué pesa adentro de una sesión */}
      <SectionCard
        icon={<BarChart3 size={17} />}
        title="¿Qué pesa adentro de una sesión?"
        description="Composición real del contexto (prompt, dreams, voz, memoria por lead) vs lo que cada sesión escribe y relee de caché"
      >
        <ContextPanel
          avgCacheWriteTok={Math.round(calculatorData.profiles.response.cwTok)}
          avgCacheReadTok={Math.round(calculatorData.profiles.response.crTok)}
        />
      </SectionCard>

      {/* Modelos por componente */}
      <SectionCard
        icon={<BarChart3 size={17} />}
        title="Modelos por componente"
        description="Elegí qué modelo usa cada pieza. Más barato = menos calidad; más caro = mejor. Aplica en menos de 1 minuto, sin redeploy."
      >
        <ModelsPanel current={currentModels} />
      </SectionCard>

      {/* Calculadora para cotizar clientes */}
      <SectionCard
        icon={<TrendUp size={17} />}
        title="Calculadora — ¿cuánto le costaría a un cliente?"
        description="Proyección mensual con los costos unitarios reales de este deployment. Para cotizar a clientes nuevos según su volumen."
      >
        {/* key = modelos asignados: al guardar en el panel, el refresh remonta
            la calculadora con los modelos nuevos como punto de partida. */}
        <CostCalculator key={Object.values(calculatorData.models).join("|")} data={calculatorData} />
      </SectionCard>

      {/* Heatmap */}
      <SectionCard icon={<BarChart3 size={17} />} title="Actividad por hora" description={`Costo por franja (TZ: ${tz})`}>
        <HeatmapGrid
          cells={heatmapCells}
          max={heatmapMax}
          label={(c) => `${formatUsd(c.value)}`}
        />
      </SectionCard>

      {/* Palancas */}
      <SectionCard icon={<TrendUp size={17} />} title="Base de optimización" description="Oportunidades detectadas en los datos reales del período">
        {palancas.length === 0 ? (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
            No se detectaron oportunidades de optimización. El consumo se ve eficiente para el período analizado.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {palancas.map((p) => (
              <div key={p.id} className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div className="flex items-start gap-2">
                  <span className="shrink-0 rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                    {p.id}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-amber-900">{p.title}</p>
                    <p className="mt-0.5 text-xs text-amber-800">{p.description}</p>
                    <p className="mt-1.5 text-xs text-amber-700 font-medium">→ {p.recommendation}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </PageShell>
  );
}
