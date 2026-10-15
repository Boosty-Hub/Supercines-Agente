// Datos del inbox compartidos entre la ruta /api/inbox/leads, la conversación
// (/inbox/[leadId]) y la lista/tablero del cliente. Sin imports de servidor: las
// funciones que consultan reciben el cliente de Supabase por parámetro. La
// paginación/filtros del inbox viven en lib/inbox-query.ts (pura, con tests).
import type { SupabaseClient } from "@supabase/supabase-js";
import { firstGrapheme } from "@/lib/text-safe";

/** Una tarjeta del inbox: un lead + su resumen (inbox_page / inbox_board, migración 0085). */
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

/**
 * Parámetros de URL que son estado del inbox: modo embed, vista, pipeline y los
 * filtros. Lista blanca para armar los enlaces entre lista y conversación: otros
 * parámetros (setup=open del asistente, ?lead= de enlaces viejos, utm_*) no se
 * propagan.
 */
export const INBOX_URL_PARAMS = [
  "mode", "vista", "pipeline", "etapa", "q", "channel", "vertical", "estado", "urgent", "rango", "sort",
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

// Ojo con los emojis: hay display_names de WhatsApp que son puro emoji. Cortar con
// slice()/[0] va por UNIDADES de código UTF-16 y parte un par suplente al medio,
// dejando un surrogate suelto: al serializar el HTML el servidor lo descarta y el
// cliente no → "Text content did not match". Por eso se corta por GRAFEMA (text-safe.ts): ni un par suplente ni un emoji compuesto a medias.
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const first = firstGrapheme(parts[0]);
    return (first + firstGrapheme(parts[0].slice(first.length))).toUpperCase();
  }
  return (firstGrapheme(parts[0]) + firstGrapheme(parts[parts.length - 1])).toUpperCase();
}
