// Edge Function: alerts-scan
//
// Cada 5 min escanea el estado del sistema y crea filas en `alerts`:
//   - draft_failed:        drafts con status='failed' sin alerta previa
//   - human_review_needed: mensajes inbound requires_human_review sin alerta y sin draft enviado
//   - outcomes_regression: graders con score promedio últimas 24h < 70% del de la semana previa
//
// Después postea cada alerta nueva al webhook configurado (Slack/Discord-friendly).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

type AlertConfig = {
  webhook_url: string | null;
  webhook_enabled: boolean;
  webhook_kinds: string[];
};

async function getConfig(): Promise<AlertConfig | null> {
  const { data } = await supabase
    .from("alert_config")
    .select("webhook_url, webhook_enabled, webhook_kinds")
    .eq("is_active", true)
    .maybeSingle();
  return data;
}

async function existingAlerts(kind: string, refIds: string[]): Promise<Set<string>> {
  if (refIds.length === 0) return new Set();
  const { data } = await supabase
    .from("alerts")
    .select("ref_id")
    .eq("kind", kind)
    .in("ref_id", refIds);
  return new Set((data ?? []).map((a) => a.ref_id as string));
}

type AlertInput = {
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  ref_table?: string;
  ref_id?: string;
  metadata?: Record<string, unknown>;
};

async function createAlert(a: AlertInput) {
  const { data, error } = await supabase
    .from("alerts")
    .insert({
      kind: a.kind,
      severity: a.severity,
      title: a.title,
      description: a.description,
      ref_table: a.ref_table ?? null,
      ref_id: a.ref_id ?? null,
      metadata: a.metadata ?? {},
    })
    .select("id")
    .single();
  if (error) throw new Error(`alert insert: ${error.message}`);
  return data?.id as string;
}

async function postWebhook(config: AlertConfig, alert: AlertInput) {
  if (!config.webhook_enabled || !config.webhook_url) return;
  if (!config.webhook_kinds.includes(alert.kind)) return;
  const emoji = alert.severity === "critical" ? "🚨" : alert.severity === "warning" ? "⚠️" : "ℹ️";
  // Payload genérico compatible con Slack y Discord
  const payload = {
    text: `${emoji} *${alert.title}*\n${alert.description}`,
    embeds: [
      {
        title: `${emoji} ${alert.title}`,
        description: alert.description,
        color: alert.severity === "critical" ? 15158332 : alert.severity === "warning" ? 16294198 : 5814783,
      },
    ],
  };
  try {
    await fetch(config.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn("webhook post failed:", e);
  }
}

// ---------------- Detectores ----------------
async function detectFailedDrafts(): Promise<AlertInput[]> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from("drafts")
    .select("id, body, agent_metadata, created_at, messages(lead_id, leads(display_name, kommo_lead_id))")
    .eq("status", "failed")
    .gte("created_at", since);
  const rows = (data ?? []) as Array<{
    id: string;
    body: string;
    // deno-lint-ignore no-explicit-any
    agent_metadata: any;
    // deno-lint-ignore no-explicit-any
    messages: any;
  }>;
  const ids = rows.map((r) => r.id);
  const existing = await existingAlerts("draft_failed", ids);
  return rows
    .filter((r) => !existing.has(r.id))
    .map((r) => {
      const leadName = r.messages?.leads?.display_name ?? `lead ${r.messages?.leads?.kommo_lead_id ?? "?"}`;
      const err = r.agent_metadata?.publish_error ?? r.agent_metadata?.error ?? "(sin detalle)";
      return {
        kind: "draft_failed",
        severity: "critical" as const,
        title: `Draft falló: ${leadName}`,
        description: String(err).slice(0, 500),
        ref_table: "drafts",
        ref_id: r.id,
        metadata: { lead_name: leadName },
      };
    });
}

async function detectHumanReviewNeeded(): Promise<AlertInput[]> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from("messages")
    .select(
      "id, content, classification, created_at, leads(display_name, kommo_lead_id)"
    )
    .eq("direction", "inbound")
    .eq("requires_human_review", true)
    // Un mensaje que el agente decidió ignorar —etapa apagada, canal
    // silenciado, "Apagar Agente" o regla de silencio— NO puede exigir
    // revisión humana: si el agente no debe meterse ahí, tampoco debe
    // levantar una alerta. Sin este filtro, la conversación interna del
    // equipo llenaba el panel de alertas.
    .eq("ignored", false)
    .gte("created_at", since);
  const rows = (data ?? []) as Array<{
    id: string;
    content: string;
    // deno-lint-ignore no-explicit-any
    classification: any;
    // deno-lint-ignore no-explicit-any
    leads: any;
  }>;
  const ids = rows.map((r) => r.id);
  const existing = await existingAlerts("human_review_needed", ids);
  return rows
    .filter((r) => !existing.has(r.id))
    .map((r) => {
      const leadName = r.leads?.display_name ?? `lead ${r.leads?.kommo_lead_id ?? "?"}`;
      const tox = r.classification?.toxicity ?? 0;
      const sev: "critical" | "warning" = tox >= 0.5 ? "critical" : "warning";
      return {
        kind: "human_review_needed",
        severity: sev,
        title: `Revisión humana: ${leadName}`,
        description: `"${r.content.slice(0, 200)}" — tox ${Number(tox).toFixed(2)}, ${r.classification?.reasoning ?? ""}`.slice(0, 500),
        ref_table: "messages",
        ref_id: r.id,
        metadata: { lead_name: leadName, classification: r.classification },
      };
    });
}

async function detectOutcomesRegression(): Promise<AlertInput[]> {
  // Comparar últimas 24h vs 7 días previos por grader (solo si hay ≥5 muestras en cada ventana)
  const now = Date.now();
  const since24 = new Date(now - 24 * 3600 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

  const { data: recent } = await supabase
    .from("outcomes")
    .select("grader_id, score, graders(slug)")
    .gte("created_at", since24)
    .not("score", "is", null);
  const { data: baseline } = await supabase
    .from("outcomes")
    .select("grader_id, score")
    .gte("created_at", since7d)
    .lt("created_at", since24)
    .not("score", "is", null);

  type Agg = { sum: number; count: number; slug: string };
  const recentAgg = new Map<string, Agg>();
  const baseAgg = new Map<string, Agg>();
  for (const r of recent ?? []) {
    // deno-lint-ignore no-explicit-any
    const slug = (r as any).graders?.slug ?? "?";
    const cur = recentAgg.get(r.grader_id as string) ?? { sum: 0, count: 0, slug };
    cur.sum += Number(r.score);
    cur.count += 1;
    recentAgg.set(r.grader_id as string, cur);
  }
  for (const r of baseline ?? []) {
    const cur = baseAgg.get(r.grader_id as string) ?? { sum: 0, count: 0, slug: "?" };
    cur.sum += Number(r.score);
    cur.count += 1;
    baseAgg.set(r.grader_id as string, cur);
  }

  const alerts: AlertInput[] = [];
  for (const [graderId, recentVal] of recentAgg.entries()) {
    if (recentVal.count < 5) continue;
    const baseVal = baseAgg.get(graderId);
    if (!baseVal || baseVal.count < 5) continue;
    const recentAvg = recentVal.sum / recentVal.count;
    const baseAvg = baseVal.sum / baseVal.count;
    if (recentAvg < 0.7 * baseAvg) {
      // Una alerta por grader por día (usamos ref_id = hash determinístico día+grader)
      const dayKey = new Date().toISOString().slice(0, 10);
      // Truco: simulamos un UUID determinístico usando un hash simple, pero como
      // alerts.ref_id es uuid, en lugar pasamos null y dedupeamos por metadata.
      alerts.push({
        kind: "outcomes_regression",
        severity: "warning",
        title: `Regresión en grader ${recentVal.slug}`,
        description: `Score 24h ${recentAvg.toFixed(3)} (n=${recentVal.count}) vs 7d prev ${baseAvg.toFixed(3)} (n=${baseVal.count}). Caída ${Math.round((1 - recentAvg / baseAvg) * 100)}%.`,
        metadata: { grader_id: graderId, day: dayKey, recent_avg: recentAvg, base_avg: baseAvg },
      });
    }
  }

  // Dedupe outcomes_regression por día+grader_id ya existente
  const { data: existing } = await supabase
    .from("alerts")
    .select("metadata")
    .eq("kind", "outcomes_regression")
    .gte("created_at", new Date(now - 24 * 3600 * 1000).toISOString());
  const existingKeys = new Set(
    (existing ?? []).map((e) => {
      // deno-lint-ignore no-explicit-any
      const m = (e as any).metadata ?? {};
      return `${m.grader_id}_${m.day}`;
    })
  );
  return alerts.filter((a) => {
    const key = `${a.metadata?.grader_id}_${a.metadata?.day}`;
    return !existingKeys.has(key);
  });
}

// Backstop: auto-resuelve alertas provider_credit_exhausted (proveedor
// 'anthropic') cuando ya se recuperaron. El gate en memoria de
// _shared/provider-errors.ts (openAlertProviders) vive por invocación de la
// función Edge — si el cold-start ocurre DESPUÉS de que se recargó el
// crédito, ni createAnthropicClient() ni transcribeAudio() ven el
// fallo→éxito dentro de la misma instancia y por lo tanto nunca disparan
// resolveProviderCreditAlert(). Este barrido cada 5 min cubre ese caso por
// evidencia directa: si hubo una llamada exitosa a Claude (fila en
// usage_events) DESPUÉS de que se abrió la alerta, ya se recuperó.
//
// NOTA: alerts.acknowledged_by es `uuid references auth.users(id)` (no
// texto libre — ver 0011_alerts.sql), así que un resolve automático no
// puede escribir un marcador ahí. Guardamos "auto:recovered" en
// metadata.resolved_by en su lugar; el estado resuelto/abierto lo sigue
// derivando 100% acknowledged_at (columna generada `status`).
async function resolveRecoveredProviderCredit(): Promise<number> {
  const { data: openAlerts } = await supabase
    .from("alerts")
    .select("id, created_at, metadata")
    .eq("kind", "provider_credit_exhausted")
    .is("acknowledged_at", null)
    .eq("metadata->>provider", "anthropic");

  let resolved = 0;
  for (const alert of (openAlerts ?? []) as Array<{
    id: string;
    created_at: string;
    // deno-lint-ignore no-explicit-any
    metadata: any;
  }>) {
    try {
      const { data: recovered } = await supabase
        .from("usage_events")
        .select("id")
        .gt("created_at", alert.created_at)
        .limit(1)
        .maybeSingle();
      if (!recovered) continue;

      const prevMeta = alert.metadata ?? {};
      const { error } = await supabase
        .from("alerts")
        .update({
          acknowledged_at: new Date().toISOString(),
          metadata: { ...prevMeta, resolved_by: "auto:recovered" },
        })
        .eq("id", alert.id);
      if (error) throw new Error(error.message);
      resolved++;
    } catch (err) {
      console.error("resolveRecoveredProviderCredit:", err instanceof Error ? err.message : String(err));
    }
  }
  return resolved;
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("alerts-scan OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const config = await getConfig();
    const [failed, review, regression, providerCreditResolved] = await Promise.all([
      detectFailedDrafts(),
      detectHumanReviewNeeded(),
      detectOutcomesRegression(),
      resolveRecoveredProviderCredit(),
    ]);
    const newAlerts = [...failed, ...review, ...regression];

    for (const a of newAlerts) {
      try {
        await createAlert(a);
        if (config) await postWebhook(config, a);
      } catch (err) {
        console.error("create alert:", err);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        created: newAlerts.length,
        breakdown: {
          draft_failed: failed.length,
          human_review_needed: review.length,
          outcomes_regression: regression.length,
          provider_credit_resolved: providerCreditResolved,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("alerts-scan:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
