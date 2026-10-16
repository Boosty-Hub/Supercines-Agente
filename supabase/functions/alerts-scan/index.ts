// Edge Function: alerts-scan
//
// Cada 5 min escanea el estado del sistema y crea filas en `alerts`:
//   - draft_failed:        drafts con status='failed' sin alerta previa
//   - human_review_needed: mensajes inbound requires_human_review sin alerta y sin draft enviado,
//                          EXCLUYENDO los que el pipeline ignoró a propósito (ver _shared/alerts-human-review.ts)
//   - outcomes_regression: graders con score promedio últimas 24h < 70% del de la semana previa
//   - inbound_silence:     cero webhooks de Kommo en 90 min de horario laboral
//   - kommo_webhook_disabled: Kommo confirma por API que el webhook está deshabilitado
//                          (ver _shared/alerts-kommo-webhook.ts)
//   - budget_exceeded:     el gasto del mes alcanzó el 100% (deja de generar) o el 110%
//                          (deja de clasificar) de MONTHLY_BUDGET_USD — una alerta por
//                          (mes, nivel); ver _shared/budget.ts
//
// Después barre TODAS las alertas pendientes de webhook (las de recién y las que insertaron
// otras funciones o el SQL) y postea las de tipos notificables (Slack/Discord-friendly).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { authorizeInternal } from "../_shared/auth.ts";
import { isBusinessHours, type BusinessHoursConfig, DEFAULT_TIMEZONE } from "../_shared/business-hours.ts";
import { truncateGraphemes } from "../_shared/text-safe.ts";
import { shouldAlertHumanReview } from "../_shared/alerts-human-review.ts";
import { criticalKinds, shouldSweep } from "../_shared/alert-kinds.ts";
import { type AlertInsert, insertAlert } from "../_shared/alerts.ts";
import { detectRegressions, type OutcomeSample } from "../_shared/outcomes-regression.ts";
import { buildWebhookPayload, isMissingClaimRpc, type WebhookAlert } from "../_shared/alert-webhook.ts";
import { filterOurWebhooks, shouldAlertKommoWebhookDisabled } from "../_shared/alerts-kommo-webhook.ts";
import { loadConfig } from "../_shared/config.ts";
import { budgetAlertLevel, budgetAlertStillApplies, getBudgetGate, parseBudget } from "../_shared/budget.ts";

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

// Toda alerta que crea este barrido pasa por el helper único (_shared/alerts.ts): nace
// PENDIENTE de webhook y la postea notifyPendingAlerts en esta misma corrida, por el mismo
// camino (rate limit + dedupe) que las que insertan otras funciones o el SQL.
type AlertInput = AlertInsert & { description: string };

async function createAlert(a: AlertInput): Promise<boolean> {
  const { error } = await insertAlert(supabase, a);
  if (error) console.error(`create alert ${a.kind}:`, error);
  return !error;
}

const WEBHOOK_TIMEOUT_MS = 10_000;

/** POST al webhook. true = el servidor lo aceptó (2xx). Nunca lanza. */
async function postWebhook(url: string, alert: WebhookAlert): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWebhookPayload(alert)),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (!res.ok) console.warn(`webhook post: HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    console.warn("webhook post failed:", e);
    return false;
  }
}

type ClaimedAlert = WebhookAlert & { id: string; kind: string; repeated: number };

// Barrido: TODAS las alertas de un tipo notificable llegan a Slack/Discord sin importar quién
// las insertó (ver _shared/alert-kinds.ts y la migración 0076). El reclamo es atómico y
// serializado (advisory lock), con rate limit (SWEEP_LIMIT por barrido), dedupe contra lo
// efectivamente posteado y descarte de las viejas. Un POST fallido NO se reintenta (preferimos
// perder un aviso a duplicarlo) pero se le quita la marca de posteada, para que el dedupe no
// suprima la próxima idéntica por un aviso que nunca llegó.
const SWEEP_LIMIT = 10;
async function notifyPendingAlerts(config: AlertConfig | null, created: AlertInput[]): Promise<number> {
  if (!shouldSweep(config)) return 0;
  const { data, error } = await supabase.rpc("claim_alerts_for_webhook", {
    p_kinds: config.webhook_kinds,
    // Las críticas del registro salen primero y un tipo no crítico tiene tope por barrido
    // (p_per_kind): una inundación de un tipo no puede tapar kommo_webhook_disabled & co.
    p_critical_kinds: criticalKinds(),
    p_limit: SWEEP_LIMIT,
  });
  if (error) {
    if (isMissingClaimRpc(error)) {
      // Funciones desplegadas ANTES que la migración 0076 (orden incorrecto): se conserva el
      // comportamiento previo — se postean directo las que creó este barrido. Al aplicar 0076,
      // su backfill las marca notificadas y no se repiten.
      console.warn("claim_alerts_for_webhook no existe (falta aplicar la migración 0076): envío directo");
      let direct = 0;
      for (const a of created) {
        if (config.webhook_kinds.includes(a.kind) && (await postWebhook(config.webhook_url, { ...a, severity: a.severity ?? "warning" }))) direct++;
      }
      return direct;
    }
    console.warn("claim_alerts_for_webhook:", error.message);
    return 0;
  }
  let posted = 0;
  for (const a of (data ?? []) as ClaimedAlert[]) {
    if (await postWebhook(config.webhook_url, a)) {
      posted++;
      continue;
    }
    const { error: relErr } = await supabase.from("alerts").update({ webhook_posted_at: null }).eq("id", a.id);
    if (relErr) console.warn(`alert ${a.id}: no se pudo desmarcar el envío fallido:`, relErr.message);
  }
  return posted;
}

// ---------------- Detectores ----------------
async function detectFailedDrafts(): Promise<AlertInput[]> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from("drafts")
    // El embed DEBE nombrar el FK: hay dos relaciones entre drafts y messages
    // (drafts.message_id y messages.answered_by_draft_id). Sin desambiguar,
    // PostgREST responde PGRST201 y esta query falla siempre. Acá queremos el
    // mensaje que ORIGINÓ el draft: drafts.message_id.
    .select("id, body, agent_metadata, created_at, messages!drafts_message_id_fkey(lead_id, leads(display_name, kommo_lead_id))")
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
        description: truncateGraphemes(String(err), 500),
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
      "id, content, classification, created_at, ignored, leads(display_name, kommo_lead_id)"
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
    ignored: boolean | null;
    // deno-lint-ignore no-explicit-any
    leads: any;
  }>;
  const ids = rows.map((r) => r.id);
  const existing = await existingAlerts("human_review_needed", ids);
  return rows
    // Defensa en profundidad: la decisión real vive en shouldAlertHumanReview
    // (testeada), no en la forma del query: cambiar el `.eq("ignored", false)` de
    // arriba no puede reabrir el falso positivo sin que el test lo note.
    .filter((r) => shouldAlertHumanReview(r) && !existing.has(r.id))
    .map((r) => {
      const leadName = r.leads?.display_name ?? `lead ${r.leads?.kommo_lead_id ?? "?"}`;
      const tox = r.classification?.toxicity ?? 0;
      const sev: "critical" | "warning" = tox >= 0.5 ? "critical" : "warning";
      return {
        kind: "human_review_needed",
        severity: sev,
        title: `Revisión humana: ${leadName}`,
        description: truncateGraphemes(`"${truncateGraphemes(r.content ?? "", 200)}" — tox ${Number(tox).toFixed(2)}, ${r.classification?.reasoning ?? ""}`, 500),
        ref_table: "messages",
        ref_id: r.id,
        metadata: { lead_name: leadName, classification: r.classification },
      };
    });
}

async function detectOutcomesRegression(): Promise<AlertInput[]> {
  // Últimas 24 h vs 7 días previos por grader Y POR JUEZ (_shared/outcomes-regression.ts):
  // un cambio de GRADER_MODEL mueve la escala sin que el agente cambie, así que solo se
  // compara contra outcomes del mismo modelo de juez (≥5 muestras en cada ventana).
  const now = Date.now();
  const since24 = new Date(now - 24 * 3600 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

  const { data: recent } = await supabase
    .from("outcomes")
    .select("grader_id, score, metadata, graders(slug, source)")
    .gte("created_at", since24)
    .not("score", "is", null);
  const { data: baseline } = await supabase
    .from("outcomes")
    .select("grader_id, score, metadata, graders(slug, source)")
    .gte("created_at", since7d)
    .lt("created_at", since24)
    .not("score", "is", null);

  // deno-lint-ignore no-explicit-any
  const toSample = (r: any): OutcomeSample => ({
    grader_id: r.grader_id,
    score: r.score,
    slug: r.graders?.slug ?? null,
    source: r.graders?.source ?? null,
    metadata: r.metadata,
  });

  const alerts: AlertInput[] = [];
  for (const reg of detectRegressions((recent ?? []).map(toSample), (baseline ?? []).map(toSample))) {
    // Una alerta por grader por día (dedupe por metadata: alerts.ref_id es uuid).
    const dayKey = new Date().toISOString().slice(0, 10);
    alerts.push({
      kind: "outcomes_regression",
      severity: "warning",
      title: `Regresión en grader ${reg.slug}`,
      description: `Score 24h ${reg.recentAvg.toFixed(3)} (n=${reg.recentCount}) vs 7d prev ${reg.baseAvg.toFixed(3)} (n=${reg.baseCount}), mismo juez (${reg.judge}). Caída ${Math.round((1 - reg.recentAvg / reg.baseAvg) * 100)}%.`,
      metadata: { grader_id: reg.graderId, day: dayKey, recent_avg: reg.recentAvg, base_avg: reg.baseAvg, judge: reg.judge },
    });
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

// ---- Silencio del webhook de Kommo ----
// Kommo DESHABILITA un webhook cuyo endpoint le falla de forma sostenida, y no
// avisa a nadie: en KIA el sistema estuvo mudo 6 días seguidos (jul 30–ago 4) y
// otros 4 (ago 7–ago 10) sin que saltara nada. Cero webhooks en horario laboral
// es, por definición, el sistema caído: o Kommo desconectó el hook, o el
// endpoint no responde. Esta alerta convierte un apagón invisible en un aviso.
const SILENCE_MINUTES = 90;
const SILENCE_REALERT_HOURS = 6; // no repetir el aviso más seguido que esto

async function detectInboundSilence(): Promise<AlertInput[]> {
  // Solo en horario laboral: de madrugada el silencio es normal.
  const { data: fu } = await supabase
    .from("follow_up_config")
    .select("timezone, business_hours, business_hours_start, business_hours_end, active_days")
    .eq("is_active", true)
    .maybeSingle();
  const hours: BusinessHoursConfig = {
    timezone: (fu?.timezone as string) || DEFAULT_TIMEZONE,
    business_hours: (fu?.business_hours as BusinessHoursConfig["business_hours"]) ?? null,
    business_hours_start: Number(fu?.business_hours_start ?? 9),
    business_hours_end: Number(fu?.business_hours_end ?? 20),
    active_days: ((fu?.active_days as number[] | null) ?? [1, 2, 3, 4, 5, 6]).map(Number),
  };
  if (!isBusinessHours(hours)) return [];

  const now = Date.now();

  // No repetir: una sola alerta cada SILENCE_REALERT_HOURS mientras dure el corte.
  const { data: recent } = await supabase
    .from("alerts")
    .select("id")
    .eq("kind", "inbound_silence")
    .gte("created_at", new Date(now - SILENCE_REALERT_HOURS * 3600 * 1000).toISOString())
    .limit(1);
  if (recent && recent.length > 0) return [];

  const since = new Date(now - SILENCE_MINUTES * 60 * 1000).toISOString();
  const { count: recentCount, error } = await supabase
    .from("inbound_queue")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since);
  // Fail-open: si la consulta falla no inventamos un apagón.
  if (error) {
    console.warn("detectInboundSilence:", error.message);
    return [];
  }
  if ((recentCount ?? 0) > 0) return [];

  // Guarda anti-falso-positivo: si la cuenta nunca tuvo tráfico (instalación
  // nueva, cliente pausado), el silencio no es una anomalía.
  const weekAgo = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const { count: weekCount } = await supabase
    .from("inbound_queue")
    .select("id", { count: "exact", head: true })
    .gte("created_at", weekAgo);
  if ((weekCount ?? 0) === 0) return [];

  return [
    {
      kind: "inbound_silence",
      severity: "critical",
      title: "Sin mensajes de Kommo hace más de 90 minutos",
      description:
        `No llegó NINGÚN webhook de Kommo en los últimos ${SILENCE_MINUTES} minutos, en pleno horario laboral. ` +
        `Lo más probable es que Kommo haya deshabilitado el webhook. Revisá en Kommo → Ajustes → Integraciones ` +
        `que el hook a /functions/v1/kommo-webhook siga activo y reconectalo si hace falta.`,
      ref_table: "inbound_queue",
      metadata: { silence_minutes: SILENCE_MINUTES, events_last_7d: weekCount ?? 0 },
    },
  ];
}

// ---- Webhook de Kommo deshabilitado (detección DIRECTA) ----
// `inbound_silence` (arriba) infiere el apagón por AUSENCIA de tráfico:
// espera 90 min, solo mira en horario laboral y —lo peor— consulta la propia
// DB, así que cuando la caída es total (Postgres abajo) no puede ni consultar
// ni escribir la alerta: el vigilante se apaga junto con lo vigilado. En
// producción (KIA-Agente) fue exactamente lo que pasó: el sistema estuvo mudo
// 6 días seguidos (jul 30–ago 4) y otros 4 (ago 7–ago 10) sin que saltara
// nada, porque además de la caída de DB, Kommo había deshabilitado el hook.
//
// Esto pregunta a KOMMO, que es la fuente de verdad y vive fuera de nuestra
// infraestructura: si el hook figura `disabled`, el sistema está mudo AHORA,
// sin esperar 90 minutos y sin importar la hora ni el estado de nuestra DB.
const WEBHOOK_PATH = "/functions/v1/kommo-webhook";
const WEBHOOK_REALERT_HOURS = 3;

async function detectKommoWebhookDisabled(): Promise<AlertInput[]> {
  try {
    const cfg = await loadConfig(supabase);
    const domain = cfg.get("KOMMO_API_DOMAIN");
    const token = cfg.get("KOMMO_ACCESS_TOKEN");
    if (!domain || !token) return []; // Kommo no conectado todavía

    const res = await fetch(`https://${domain}/api/v4/webhooks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return []; // fail-open: no inventamos un apagón por un 5xx/timeout de Kommo
    const body = await res.json();
    const hooks = (body?._embedded?.webhooks ?? []) as Array<
      { destination?: string; disabled?: boolean }
    >;
    if (!shouldAlertKommoWebhookDisabled(hooks, WEBHOOK_PATH)) return [];

    // Dedupe: un aviso cada WEBHOOK_REALERT_HOURS mientras dure el apagón.
    const { data: recent } = await supabase
      .from("alerts")
      .select("id")
      .eq("kind", "kommo_webhook_disabled")
      .gte("created_at", new Date(Date.now() - WEBHOOK_REALERT_HOURS * 3600 * 1000).toISOString())
      .limit(1);
    if (recent && recent.length > 0) return [];

    return [
      {
        kind: "kommo_webhook_disabled",
        severity: "critical",
        title: "Kommo deshabilitó el webhook: el agente está MUDO",
        description:
          "Kommo marcó el webhook como deshabilitado. NO está entrando ningún mensaje y el agente no puede responder. " +
          "Kommo lo apaga cuando el endpoint le falla de forma sostenida (típicamente porque la base de datos estuvo lenta o caída). " +
          "Reactivalo en Kommo → Ajustes → Integraciones, o re-suscribiendo el hook por API (POST /api/v4/webhooks con el mismo destination).",
        ref_table: "inbound_queue",
        metadata: { destination_path: WEBHOOK_PATH, hooks_checked: filterOurWebhooks(hooks, WEBHOOK_PATH).length },
      },
    ];
  } catch (err) {
    // Fail-open a propósito: un fallo de red hacia Kommo no es un apagón nuestro.
    console.warn("detectKommoWebhookDisabled:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ---- Techo de gasto mensual ----
// El gate (_shared/budget.ts) frena en el hot path pero NO avisa: el aviso sale
// por acá para pasar por el mismo camino de dedupe/webhook/panel que el resto.
// Una alerta ABIERTA por (mes, nivel): el 110% no repite la del 100% del mismo
// mes, y si se resolvió (subió el techo) y se vuelve a cruzar, avisa de nuevo.
async function detectBudgetExceeded(): Promise<AlertInput[]> {
  try {
    const cfg = await loadConfig(supabase);
    const gate = await getBudgetGate(supabase, cfg);
    const level = budgetAlertLevel(gate);
    const budgetUsd = parseBudget(cfg.get("MONTHLY_BUDGET_USD"));
    if (level === null || budgetUsd === null) return [];

    const month = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC, igual que gasto_mes_actual)
    const { data: existing } = await supabase
      .from("alerts")
      .select("id")
      .eq("kind", "budget_exceeded")
      .is("acknowledged_at", null)
      .eq("metadata->>month", month)
      .eq("metadata->>nivel", String(level))
      .limit(1);
    if (existing && existing.length > 0) return [];

    const spendUsd = (gate.pct / 100) * budgetUsd;
    return [{
      kind: "budget_exceeded",
      severity: level >= 110 ? "critical" : "warning",
      title: `Presupuesto mensual al ${level}%`,
      description:
        `El gasto estimado de IA de este mes ($${spendUsd.toFixed(2)}) alcanzó el ${level}% del presupuesto ` +
        `configurado ($${budgetUsd.toFixed(2)}). ` +
        (level >= 110
          ? "Se dejaron de generar respuestas y de clasificar mensajes nuevos; los mensajes se siguen guardando y se clasifican y responden al reanudar."
          : "Se dejaron de generar respuestas, seguimientos, evaluaciones y Dreams; los mensajes se siguen clasificando y guardando y se responden al reanudar."),
      metadata: { month, nivel: level, spend_usd: Number(spendUsd.toFixed(2)), budget_usd: budgetUsd },
    }];
  } catch (err) {
    // Fail-open: un fallo acá no debe tumbar el resto del escaneo.
    console.warn("detectBudgetExceeded:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

// Auto-resuelve las alertas budget_exceeded que ya no aplican (cambió el mes, se
// subió o quitó el techo, o el gasto bajó). Mismo criterio que
// resolveRecoveredProviderCredit: acknowledged_by es uuid, así que el marcador de
// resolución automática va en metadata.resolved_by.
async function resolveRecoveredBudget(): Promise<number> {
  try {
    const { data: open } = await supabase
      .from("alerts")
      .select("id, metadata")
      .eq("kind", "budget_exceeded")
      .is("acknowledged_at", null);
    if (!open || open.length === 0) return 0;

    const cfg = await loadConfig(supabase);
    const level = budgetAlertLevel(await getBudgetGate(supabase, cfg));
    const month = new Date().toISOString().slice(0, 7);
    let resolved = 0;
    // deno-lint-ignore no-explicit-any
    for (const a of open as Array<{ id: string; metadata: any }>) {
      const m = a.metadata ?? {};
      if (budgetAlertStillApplies({ month: String(m.month ?? ""), nivel: Number(m.nivel) || 0 }, level, month)) continue;
      const { error } = await supabase
        .from("alerts")
        .update({ acknowledged_at: new Date().toISOString(), metadata: { ...m, resolved_by: "auto:recovered" } })
        .eq("id", a.id);
      if (!error) resolved++;
    }
    return resolved;
  } catch (err) {
    console.warn("resolveRecoveredBudget:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("alerts-scan OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  // Gate interno: esta función NO es un webhook público (ver _shared/auth.ts).
  {
    const denied = await authorizeInternal(req, supabase);
    if (denied) return denied;
  }

  try {
    const config = await getConfig();
    const [failed, review, regression, silence, hookDisabled, budgetAlerts, budgetResolved, providerCreditResolved] = await Promise.all([
      detectFailedDrafts(),
      detectHumanReviewNeeded(),
      detectOutcomesRegression(),
      detectInboundSilence(),
      detectKommoWebhookDisabled(),
      detectBudgetExceeded(),
      resolveRecoveredBudget(),
      resolveRecoveredProviderCredit(),
    ]);
    const newAlerts = [...failed, ...review, ...regression, ...silence, ...hookDisabled, ...budgetAlerts];

    const created: AlertInput[] = [];
    for (const a of newAlerts) if (await createAlert(a)) created.push(a);

    const posted = await notifyPendingAlerts(config, created);

    return new Response(
      JSON.stringify({
        ok: true,
        created: created.length,
        webhook_posted: posted,
        breakdown: {
          draft_failed: failed.length,
          human_review_needed: review.length,
          outcomes_regression: regression.length,
          inbound_silence: silence.length,
          kommo_webhook_disabled: hookDisabled.length,
          budget_exceeded: budgetAlerts.length,
          budget_resolved: budgetResolved,
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
