// Edge Function: dreams-run
//
// Destila aprendizajes y los escribe como archivos en el master Memory Store
// bajo /dreams/. El agente al servir un mensaje hace grep sobre
// /mnt/memory/<master>/dreams/ y los toma como reglas implícitas.
//
// Inputs:
//   POST { period: "daily" }   → últimas 24h (conversations del día)
//   POST { period: "weekly" }  → últimos 7d (learnings de leads, anonimizados)
//
// Implementación: usamos el Messages API directo (no CMA) porque es un job batch.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@0.95.1";
import { loadConfig, type ConfigReader } from "../_shared/config.ts";
import { recordUsage } from "../_shared/usage.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

type Period = "daily" | "weekly";

// ---------------- Daily: conversaciones del día ----------------
// transcript anonimizado + mapa Lead#N → lead_id real. El mapa viaja en el
// frontmatter de cada dream para que el dashboard pueda linkear la evidencia
// a la conversación real (el transcript que ve Sonnet sigue anonimizado).
type Gathered = { transcript: string; leadMap: Map<string, string> };

async function gatherDaily(sinceIso?: string): Promise<Gathered> {
  // Ventana dinámica: por defecto 24h, pero con frecuencias > diaria se pasa el
  // hueco real desde la última corrida para no perder días (ver handler).
  const since = sinceIso ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  // OJO: hay DOS FKs entre messages y drafts (drafts.message_id y
  // messages.answered_by_draft_id) — el embed sin desambiguar da PGRST201.
  // Usamos answered_by_draft_id: empareja cada inbound con el draft que
  // respondió su batch completo.
  const { data: messages, error } = await supabase
    .from("messages")
    .select(
      "lead_id, direction, content, source, classification, created_at, verticals(slug), draft:drafts!messages_answered_by_draft_id_fkey(body, edited_body, status)"
    )
    .gte("created_at", since)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`gatherDaily: ${error.message}`);

  // Agrupar por lead, anonimizado
  const byLead = new Map<string, string[]>();
  const lastDraftLine = new Map<string, string>();
  let leadCounter = 1;
  const leadLabels = new Map<string, string>();

  for (const m of messages ?? []) {
    const label = leadLabels.get(m.lead_id) ?? (() => {
      const l = `Lead#${leadCounter++}`;
      leadLabels.set(m.lead_id, l);
      return l;
    })();
    if (!byLead.has(label)) byLead.set(label, []);
    // deno-lint-ignore no-explicit-any
    const v = (m as any).verticals;
    const verticalSlug = Array.isArray(v) ? v[0]?.slug : v?.slug;
    // deno-lint-ignore no-explicit-any
    const draft = (m as any).draft as { body: string; edited_body: string | null; status: string } | null;

    const channel = m.source ?? "?";
    byLead.get(label)!.push(
      `[${m.direction === "inbound" ? "lead" : "agente"} • ${channel}${verticalSlug ? " • " + verticalSlug : ""}] ${m.content}`
    );
    if (m.direction === "inbound" && draft) {
      // Un draft cubre todo el batch del lead: no repetir la misma respuesta
      // por cada mensaje del batch.
      const line = `[agente respuesta • ${draft.status}] ${draft.edited_body ?? draft.body}`;
      if (lastDraftLine.get(label) !== line) {
        byLead.get(label)!.push(line);
        lastDraftLine.set(label, line);
      }
    }
  }

  const parts: string[] = [];
  for (const [label, lines] of byLead.entries()) {
    parts.push(`## ${label}\n${lines.join("\n")}`);
  }
  const leadMap = new Map<string, string>();
  for (const [leadId, label] of leadLabels.entries()) leadMap.set(label, leadId);
  return { transcript: parts.join("\n\n---\n\n"), leadMap };
}

// ---------------- Weekly: learnings de leads, anonimizados ----------------
async function gatherWeekly(): Promise<Gathered> {
  // Listamos los archivos /<lead_id>/learnings.md en el leads store
  // y los traemos. Para simplicidad acá usamos lo mismo que daily pero 7 días.
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: messages, error } = await supabase
    .from("messages")
    .select(
      "lead_id, direction, content, source, classification, created_at, verticals(slug), draft:drafts!messages_answered_by_draft_id_fkey(body, edited_body, status)"
    )
    .gte("created_at", since)
    .order("lead_id", { ascending: true });
  if (error) throw new Error(`gatherWeekly: ${error.message}`);

  const byLead = new Map<string, { vertical: string | null; turns: string[] }>();
  const lastDraftLine = new Map<string, string>();
  let leadCounter = 1;
  const leadLabels = new Map<string, string>();

  for (const m of messages ?? []) {
    const label = leadLabels.get(m.lead_id) ?? (() => {
      const l = `Lead#${leadCounter++}`;
      leadLabels.set(m.lead_id, l);
      return l;
    })();
    if (!byLead.has(label)) byLead.set(label, { vertical: null, turns: [] });
    const entry = byLead.get(label)!;
    // deno-lint-ignore no-explicit-any
    const v = (m as any).verticals;
    const verticalSlug = (Array.isArray(v) ? v[0]?.slug : v?.slug) ?? null;
    if (verticalSlug && !entry.vertical) entry.vertical = verticalSlug;
    entry.turns.push(`${m.direction}: ${m.content}`);
    // deno-lint-ignore no-explicit-any
    const draft = (m as any).draft as { body: string; edited_body: string | null; status: string } | null;
    if (m.direction === "inbound" && draft) {
      const line = `agente (${draft.status}): ${draft.edited_body ?? draft.body}`;
      if (lastDraftLine.get(label) !== line) {
        entry.turns.push(line);
        lastDraftLine.set(label, line);
      }
    }
  }

  // Compactar por vertical para facilitar el análisis
  const byVertical = new Map<string, string[]>();
  for (const [label, entry] of byLead.entries()) {
    const v = entry.vertical ?? "general";
    if (!byVertical.has(v)) byVertical.set(v, []);
    byVertical.get(v)!.push(`### ${label}\n${entry.turns.join("\n")}`);
  }

  const parts: string[] = [];
  for (const [vertical, leads] of byVertical.entries()) {
    parts.push(`# Vertical: ${vertical}\n${leads.join("\n\n")}`);
  }
  const leadMap = new Map<string, string>();
  for (const [leadId, label] of leadLabels.entries()) leadMap.set(label, leadId);
  return { transcript: parts.join("\n\n---\n\n"), leadMap };
}

// ---------------- Prompt para Dreams ----------------
function dreamPrompt(period: Period, transcript: string, operator: string): string {
  const periodLabel = period === "daily" ? "ÚLTIMAS 24 HORAS" : "ÚLTIMOS 7 DÍAS";
  return `Eres el sistema de "Dreams" del agente conversacional de ${operator}. Tu trabajo es analizar conversaciones recientes y destilar APRENDIZAJES que mejoren al agente en el futuro.

PERÍODO: ${periodLabel}

CONVERSACIONES (anonimizadas con Lead#N):
${transcript || "(sin conversaciones en el período)"}

Tu salida debe ser un JSON con un array "learnings". Cada item debe ser un aprendizaje accionable que merezca guardarse como regla persistente. Categorías permitidas:
- "objection_pattern": una objeción recurrente y cómo responderla
- "voice_rule": una observación sobre tono/voz que el agente debe replicar (si la voz del operador en su system prompt tiene reglas regionales o estilísticas y detectás que el agente las violó, flaggéalo como anti_pattern)
- "factual_gap": una pregunta factual recurrente que NO está en la KB y debería agregarse
- "successful_phrasing": una frase o estructura que funcionó bien
- "anti_pattern": algo que el agente hizo y NO debería repetir

Cada learning lleva además una "severity":
- "error": el agente DIJO o HARÍA algo incorrecto (dato falso, violación de una regla de su prompt, promesa que el negocio no puede cumplir). Corregirlo es urgente.
- "advertencia": falta información (gap de KB, dato desactualizado) o hay riesgo de inconsistencia. El agente no se equivocó, pero no pudo resolver.
- "sugerencia": refuerzo de algo que funcionó o una mejora opcional de estilo/flujo.

Reglas:
- Escribí los learnings en el mismo registro/voz que define el system prompt del agente.
- NO inventes aprendizajes. Si no hay patrón claro, devuelve learnings: [].
- Cada aprendizaje debe ser ESPECÍFICO, no genérico ("siempre sé empático" NO sirve).
- Citá brevemente la evidencia (qué turno/conversación la respalda).
- Sé conservador con "error": resérvalo para fallas reales del agente, no para gaps de información.
- Máximo 8 learnings por run.

Formato JSON:
{
  "learnings": [
    {
      "title": "string corto (slug-friendly, snake_case)",
      "category": "objection_pattern" | "voice_rule" | "factual_gap" | "successful_phrasing" | "anti_pattern",
      "severity": "sugerencia" | "advertencia" | "error",
      "vertical": "<slug-de-una-vertical-de-la-DB-o-cross>",
      "content": "descripción accionable del aprendizaje (2-5 oraciones)",
      "evidence": "qué viste en las conversaciones que lo respalda (1-2 oraciones)"
    }
  ]
}`;
}

// ---------------- Escribir a memory store ----------------
type Learning = {
  title: string;
  category: string;
  severity: string;
  vertical: string;
  content: string;
  evidence: string;
};

type Severity = "sugerencia" | "advertencia" | "error";

// Normaliza la severity del modelo; fallback por categoría si viene rara.
function normalizeSeverity(l: Learning): Severity {
  const s = String(l.severity ?? "").toLowerCase();
  if (s === "error") return "error";
  if (s.startsWith("adv") || s === "warning") return "advertencia";
  if (s.startsWith("sug") || s === "info") return "sugerencia";
  return l.category === "anti_pattern"
    ? "error"
    : l.category === "factual_gap"
    ? "advertencia"
    : "sugerencia";
}

// Token corto de severity en el filename → el dashboard la muestra sin tener
// que leer el contenido de cada dream.
const SEV_TOKEN: Record<Severity, string> = {
  sugerencia: "sug",
  advertencia: "adv",
  error: "err",
};

// active=true → /dreams/ (el agente lo lee al responder, efecto inmediato).
// active=false → /dreams-pending/ (NO lo lee nadie hasta que se apruebe en el
// dashboard, que lo mueve a /dreams/).
async function writeLearning(
  period: Period,
  idx: number,
  learning: Learning,
  severity: Severity,
  active: boolean,
  leadMap: Map<string, string>,
  anthropic: Anthropic,
  memstoreMaster: string
) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = String(learning.title)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  const root = active ? "/dreams" : "/dreams-pending";
  const path = `${root}/${period}/${date}_${String(idx).padStart(2, "0")}_${SEV_TOKEN[severity]}_${slug || "learning"}.md`;

  // Los Lead#N citados en este learning, mapeados a su lead real para que el
  // dashboard pueda abrir la conversación desde la evidencia.
  const mentioned = new Set(
    `${learning.content} ${learning.evidence}`.match(/Lead#\d+/g) ?? []
  );
  const leadRefs = [...mentioned]
    .filter((label) => leadMap.has(label))
    .map((label) => `${label}=${leadMap.get(label)}`)
    .join("; ");

  const content =
    `---\n` +
    `category: ${learning.category}\n` +
    `severity: ${severity}\n` +
    `vertical: ${learning.vertical}\n` +
    `period: ${period}\n` +
    `date: ${date}\n` +
    `title: ${JSON.stringify(learning.title)}\n` +
    (leadRefs ? `leads: ${leadRefs}\n` : "") +
    `---\n\n` +
    `# ${learning.title}\n\n` +
    `${learning.content}\n\n` +
    `**Evidencia:** ${learning.evidence}\n`;

  await anthropic.beta.memoryStores.memories.create(memstoreMaster, { path, content });
  return path;
}

// ---------------- Main ----------------
type ActivationPolicy = "all" | "error" | "none";

async function runDreams(
  period: Period,
  anthropic: Anthropic,
  memstoreMaster: string,
  operator: string,
  policy: ActivationPolicy,
  cfg: ConfigReader,
  sinceIso?: string
) {
  const { transcript, leadMap } = period === "daily" ? await gatherDaily(sinceIso) : await gatherWeekly();

  // Modelo de Dreams: editable desde /consumo (DB-first, fallback Sonnet).
  const dreamsModel = cfg.getOr("DREAMS_MODEL", "claude-sonnet-4-6");
  const response = await anthropic.messages.create({
    model: dreamsModel,
    max_tokens: 4096,
    system: "Eres un analista riguroso que destila aprendizajes de conversaciones reales. No alucines.",
    messages: [{ role: "user", content: dreamPrompt(period, transcript, operator) }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            learnings: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  title: { type: "string" },
                  category: { type: "string" },
                  severity: { type: "string", enum: ["sugerencia", "advertencia", "error"] },
                  vertical: { type: "string" },
                  content: { type: "string" },
                  evidence: { type: "string" },
                },
                required: ["title", "category", "severity", "vertical", "content", "evidence"],
              },
            },
          },
          required: ["learnings"],
        },
      },
    },
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("no text in response");
  const parsed = JSON.parse(block.text) as { learnings: Learning[] };

  // Captura fail-open de consumo dreams
  await recordUsage(supabase, {
    component: "dreams", model: dreamsModel,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens,
    // deno-lint-ignore no-explicit-any
    cacheCreation5m: (response.usage as any)?.cache_creation?.ephemeral_5m_input_tokens,
    metadata: { period },
    pricingOverrideRaw: cfg.get("AI_PRICING_OVERRIDES"),
  });

  // Política de activación (runtime_config DREAMS_AUTO_ACTIVATE):
  //   "all"   → todo se activa al instante (default, comportamiento original)
  //   "error" → solo los errores se auto-activan (autocorrección inmediata);
  //             sugerencias/advertencias quedan pendientes de aprobación
  //   "none"  → todo queda pendiente; el operador aprueba desde /dreams
  const paths: string[] = [];
  let activeCount = 0;
  let pendingCount = 0;
  for (let i = 0; i < parsed.learnings.length; i++) {
    const learning = parsed.learnings[i];
    const severity = normalizeSeverity(learning);
    const active =
      policy === "all" || (policy === "error" && severity === "error");
    try {
      const p = await writeLearning(period, i, learning, severity, active, leadMap, anthropic, memstoreMaster);
      paths.push(p);
      if (active) activeCount++;
      else pendingCount++;

      // Un error siempre genera alerta: si se auto-activó, para que el operador
      // sepa que el agente ya se está autocorrigiendo; si quedó pendiente, para
      // que lo apruebe cuanto antes.
      if (severity === "error") {
        const { error: alertErr } = await supabase.from("alerts").insert({
          kind: "dream_error",
          severity: "warning",
          title: `Dream con severidad ERROR: ${learning.title}`,
          description:
            `${learning.content}\n\nEvidencia: ${learning.evidence}\n\n` +
            (active
              ? "Estado: ACTIVO — el agente ya adoptó esta corrección."
              : "Estado: PENDIENTE — aprobalo en /dreams para que el agente lo adopte."),
          metadata: { path: p, period, category: learning.category, active },
        });
        if (alertErr) console.warn("alert dream_error:", alertErr.message);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("write learning:", msg);
    }
  }
  return { count: paths.length, active: activeCount, pending: pendingCount, paths };
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("dreams-run OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  let body: { period?: string; force?: boolean } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    // ignore
  }
  const period = (body.period === "weekly" ? "weekly" : "daily") as Period;
  const force = body.force === true; // el botón manual fuerza; el cron no.

  try {
    // Resolve config at request time: DB-first, then env fallback.
    const cfg = await loadConfig(supabase);

    // Frecuencia configurable (solo gobierna el run 'daily'; 'weekly' es aparte).
    // El cron dispara a diario y acá decidimos si toca correr según DREAMS_FREQUENCY
    // y la última corrida efectiva (DREAMS_LAST_RUN). Tolerancia de 12h por el
    // jitter del cron de las 3 AM.
    const DAY = 86_400_000;
    let sinceIso: string | undefined;
    if (period === "daily") {
      const FREQ_DAYS: Record<string, number> = { daily: 1, "3d": 3, "7d": 7, "15d": 15 };
      const freqDays = FREQ_DAYS[cfg.getOr("DREAMS_FREQUENCY", "daily")] ?? 1;
      const lastRunRaw = cfg.get("DREAMS_LAST_RUN");
      const lastRunMs = lastRunRaw ? Date.parse(lastRunRaw) : NaN;
      if (!force && Number.isFinite(lastRunMs)) {
        const elapsed = Date.now() - lastRunMs;
        const dueMs = freqDays * DAY - 12 * 3_600_000;
        if (elapsed < dueMs) {
          return new Response(
            JSON.stringify({ ok: true, skipped: true, reason: "not_due", freqDays, lastRun: lastRunRaw }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }
      // Ventana = hueco real desde la última corrida (clamp 1..30 días), o freqDays
      // días si es la primera corrida. Así 3d/7d/15d no pierden los días previos.
      const spanMs = Number.isFinite(lastRunMs)
        ? Math.min(Math.max(Date.now() - lastRunMs, DAY), 30 * DAY)
        : Math.min(freqDays * DAY, 30 * DAY);
      sinceIso = new Date(Date.now() - spanMs).toISOString();
    }

    const anthropic = new Anthropic({ apiKey: cfg.require("ANTHROPIC_API_KEY") });
    const memstoreMaster = cfg.require("ANTHROPIC_MEMORY_MASTER_ID");
    const operator = cfg.getOr("OPERATOR_NAME", "el operador");
    const rawPolicy = cfg.getOr("DREAMS_AUTO_ACTIVATE", "all");
    const policy: ActivationPolicy =
      rawPolicy === "error" || rawPolicy === "none" ? rawPolicy : "all";

    const result = await runDreams(period, anthropic, memstoreMaster, operator, policy, cfg, sinceIso);

    // Marca de la última corrida daily efectiva (para el due-check de la próxima).
    if (period === "daily") {
      const nowIso = new Date().toISOString();
      const { error: stampErr } = await supabase
        .from("runtime_config")
        .upsert({ key: "DREAMS_LAST_RUN", value: nowIso, updated_at: nowIso, updated_by: "dreams-run" }, { onConflict: "key" });
      if (stampErr) console.warn("stamp DREAMS_LAST_RUN:", stampErr.message);
    }

    return new Response(JSON.stringify({ ok: true, period, ...result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("dreams-run:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
