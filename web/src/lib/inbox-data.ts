// Datos del inbox compartidos entre la ruta /api/inbox/leads, la conversación
// (/inbox/[leadId]) y la lista/tablero del cliente. Sin imports de servidor: las
// funciones que consultan reciben el cliente de Supabase por parámetro.
import type { SupabaseClient } from "@supabase/supabase-js";

/** Una fila de `inbox_lead_summaries()` (migración 0061). */
export type LeadSummary = {
  id: string;
  display_name: string | null;
  channel: string | null;
  kommo_lead_id: number | null;
  kommo_pipeline_id: number | null;
  kommo_stage_id: number | null;
  /** Un recorrido completo de Kommo no encontró el lead (borrado allá). No es trabajo pendiente. */
  kommo_missing_at: string | null;
  last_message_at: string | null;
  msg_count: number;
  last_content: string | null;
  last_direction: string | null;
  last_created_at: string | null;
  last_vertical: string | null;
  has_review_pending: boolean;
  max_urgency: number;
  max_toxicity: number;
  verticals: string[] | null;
  /**
   * El lead escribió después de la última respuesta enviada, no se lo silenció a
   * propósito y el agente no lo tomó todavía. NO usar `last_direction`: `messages`
   * guarda lo que escribe el lead y las respuestas del agente viven en `drafts`.
   */
  awaiting_reply: boolean;
  /** Última respuesta del agente que salió a Kommo. */
  last_reply_at: string | null;
};

/** Configuración con que se calcula el estado del agente en cada tarjeta. */
export type AgentStatusCfg = {
  systemHalted: boolean;
  agentEnabled: boolean;
  publishingEnabled: boolean;
  salesbotId: number | null;
  ignoredStageIds: number[];
};

export type BoardStage = { id: number; name: string; sort: number; type: number; color: string | null };
export type BoardPipeline = { id: number; name: string; sort: number; is_main: boolean; stages: BoardStage[] };

export type InboxListData = {
  leads: LeadSummary[];
  agentCfg: AgentStatusCfg;
  /** Pipelines activos (sin archivados) con sus etapas en el orden de Kommo. */
  pipelines: BoardPipeline[];
};

/**
 * Parámetros de URL que son estado del inbox: modo embed, vista, pipeline y los
 * filtros. Lista blanca para armar los enlaces entre lista y conversación: otros
 * parámetros (setup=open del asistente, ?lead= de enlaces viejos, utm_*) no se
 * propagan.
 */
export const INBOX_URL_PARAMS = [
  "mode", "vista", "pipeline", "q", "channel", "vertical", "estado", "urgent", "rango", "sort",
] as const;

/** Etapas de sistema de Kommo, con el MISMO id en todos los pipelines. */
export const STAGE_WON = 142;
export const STAGE_LOST = 143;

/** Pipelines y etapas desde la copia local (kommo_pipelines / kommo_stages, 0061). */
export async function fetchBoardPipelines(supabase: SupabaseClient): Promise<BoardPipeline[]> {
  const [{ data: pipes, error: e1 }, { data: stages, error: e2 }] = await Promise.all([
    supabase.from("kommo_pipelines").select("id, name, sort, is_main, is_archive"),
    supabase.from("kommo_stages").select("pipeline_id, id, name, sort, type, color"),
  ]);
  if (e1 || e2) throw new Error(`pipelines: ${(e1 ?? e2)!.message}`);
  const byPipeline = new Map<number, BoardStage[]>();
  for (const s of stages ?? []) {
    const k = Number(s.pipeline_id);
    const list = byPipeline.get(k) ?? [];
    list.push({ id: Number(s.id), name: s.name, sort: s.sort, type: s.type, color: s.color });
    byPipeline.set(k, list);
  }
  return (pipes ?? [])
    .filter((p) => !p.is_archive)
    .map((p) => ({
      id: Number(p.id),
      name: p.name,
      sort: p.sort,
      is_main: p.is_main,
      stages: (byPipeline.get(Number(p.id)) ?? []).sort((a, b) => a.sort - b.sort),
    }))
    // El principal primero, después el orden de Kommo.
    .sort((a, b) => Number(b.is_main) - Number(a.is_main) || a.sort - b.sort);
}

const PAGE = 1000; // max_rows de PostgREST

/**
 * Todos los resúmenes, pidiendo las dos primeras páginas A LA VEZ: cada página
 * recalcula la función entera y en fila el total se duplica. Si la segunda viene
 * llena, sigue en serie. Orden por id (clave inmutable) para que la paginación
 * no repita ni se salte filas cuando llegan mensajes mientras se lee.
 */
export async function fetchLeadSummaries(supabase: SupabaseClient): Promise<LeadSummary[]> {
  const page = async (from: number) => {
    const { data, error } = await supabase
      .rpc("inbox_lead_summaries")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    // Lanzar, nunca devolver lo que llegó: una página perdida se vería como un
    // total creíble y equivocado.
    if (error) throw new Error(`inbox_lead_summaries [${from}]: ${error.message}`);
    return (data ?? []) as LeadSummary[];
  };
  const [p0, p1] = await Promise.all([page(0), page(PAGE)]);
  const out = [...p0, ...p1];
  let last = p1;
  for (let from = 2 * PAGE; last.length === PAGE; from += PAGE) {
    last = await page(from);
    out.push(...last);
  }
  return out.map((l) => ({
    ...l,
    // numeric de Postgres llega como string por PostgREST.
    max_urgency: Number(l.max_urgency) || 0,
    max_toxicity: Number(l.max_toxicity) || 0,
  }));
}

export type PublishCfgRow = {
  system_halted: boolean | null;
  agent_enabled: boolean | null;
  publishing_enabled: boolean | null;
  salesbot_id: number | null;
  ignored_stage_ids: unknown[] | null;
};

export async function fetchPublishCfg(supabase: SupabaseClient): Promise<PublishCfgRow | null> {
  // Dos consultas a propósito: `system_halted` va APARTE. Si la migración que la
  // agrega todavía no se aplicó en este proyecto, ese select falla solo y el
  // resto del estado del agente sigue llegando (fail-open: se toma como no
  // apagado). Sumarla al select grande haría que UNA columna faltante dejara la
  // config entera en null y el inbox mostrara el estado equivocado.
  const [{ data }, { data: halt }] = await Promise.all([
    supabase
      .from("kommo_publish_config")
      .select("agent_enabled, publishing_enabled, salesbot_id, ignored_stage_ids")
      .eq("is_active", true)
      .maybeSingle(),
    supabase.from("kommo_publish_config").select("system_halted").eq("is_active", true).maybeSingle(),
  ]);
  if (!data && !halt) return null;
  return {
    system_halted: (halt as { system_halted?: boolean | null } | null)?.system_halted ?? null,
    agent_enabled: null,
    publishing_enabled: null,
    salesbot_id: null,
    ignored_stage_ids: null,
    ...((data as Omit<PublishCfgRow, "system_halted"> | null) ?? {}),
  };
}

export function toAgentStatusCfg(row: PublishCfgRow | null): AgentStatusCfg {
  return {
    systemHalted: row?.system_halted === true,
    // generate-response solo bloquea con agent_enabled === false explícito.
    agentEnabled: row?.agent_enabled !== false,
    publishingEnabled: row?.publishing_enabled === true,
    salesbotId: row?.salesbot_id ?? null,
    ignoredStageIds: (row?.ignored_stage_ids ?? []).map(Number).filter((n) => Number.isFinite(n)),
  };
}

// ── Helpers de presentación (compartidos por lista, tablero y conversación) ──

export function normChannel(ch: string | null): string {
  if (!ch) return "other";
  const c = ch.toLowerCase();
  if (c.includes("whatsapp") || c === "waba") return "whatsapp";
  if (c.includes("instagram")) return "instagram";
  if (c.includes("facebook") || c === "fb") return "facebook";
  if (c.includes("tiktok")) return "tiktok";
  if (c.includes("telegram")) return "telegram";
  return "other";
}

export function withinRange(iso: string | null, rango: string): boolean {
  if (!rango) return true;
  if (!iso) return false;
  const age = Date.now() - new Date(iso).getTime();
  const H = 3600_000;
  const D = 24 * H;
  if (rango === "1h") return age <= H;
  if (rango === "today") return age <= D;
  if (rango === "7d") return age <= 7 * D;
  if (rango === "30d") return age <= 30 * D;
  return true;
}

// Ojo con los emojis: hay display_names de WhatsApp que son puro emoji. Cortar con
// slice()/[0] va por UNIDADES de código UTF-16 y parte un par suplente al medio,
// dejando un surrogate suelto: al serializar el HTML el servidor lo descarta y el
// cliente no → "Text content did not match". Por eso se corta por PUNTOS DE CÓDIGO.
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join("").toUpperCase();
  const first = Array.from(parts[0])[0] ?? "";
  const last = Array.from(parts[parts.length - 1])[0] ?? "";
  return (first + last).toUpperCase();
}
