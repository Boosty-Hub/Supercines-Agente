// Capa de datos del inbox paginado (migración 0085), PURA: sin React, sin fetch y sin imports
// de valor, para que la usen la ruta de la API, el cliente y los tests de node.
//
// El servidor (inbox_board / inbox_page / inbox_stats) filtra, ordena y pagina; el cliente
// guarda solo lo que se ve: por columna del tablero, las tarjetas cargadas + el total + el
// cursor de la siguiente página. Acá vive:
//   · la lectura de la URL (filtros, orden, vista, pipeline) con listas blancas,
//   · la forma de los datos que devuelve la API,
//   · las transformaciones del estado: «Ver más», recarga en vivo conservando lo cargado,
//     y el movimiento optimista de una tarjeta (con los totales de las columnas).
import type { AgentStatusCfg, BoardPipeline, LeadSummary } from "./inbox-data";

export const ESTADOS = ["waiting", "answered", "review", "toxic"] as const;
export const RANGOS = ["1h", "today", "7d", "30d"] as const;
export const SORTS = ["recent", "oldest", "urgency", "messages"] as const;
/** Pestañas de la vista Lista de SuperCines (el agente responde la etapa del lead). */
export const ETAPAS = ["agente", "apagadas", "todas"] as const;
export type EtapaTab = (typeof ETAPAS)[number];
export type InboxSort = (typeof SORTS)[number];

/** Filtros del inbox: mismas claves que la URL y que `p_filters` de la base (inbox_filter_sql). */
export type InboxFilters = {
  q?: string;
  channel?: string;
  vertical?: string;
  estado?: (typeof ESTADOS)[number];
  urgent?: true;
  rango?: (typeof RANGOS)[number];
  /** Pestaña de la lista («todas» no se manda). El tablero no la aplica. */
  etapa?: Exclude<EtapaTab, "todas">;
};

/** Pseudo-pipelines del tablero (mismos valores que la base). */
export const SIN_UBICAR = -1;
export const NO_EXISTE = -2;
/** Columna de leads con una etapa que ya no existe en su pipeline. */
export const COLUMNA_OTRAS = "otras";
/** Única columna de los pseudo-pipelines. */
export const COLUMNA_UNICA = "all";

/** Tarjetas por columna en la primera carga del tablero y en cada «Ver más». */
export const BOARD_PAGE = 30;
/** Filas por página de la vista Lista. */
export const LIST_PAGE = 50;
/** Tope de filas por pedido (también lo aplica la base). */
export const MAX_PAGE = 500;

export type InboxCursor = { t: string; id: string; k: string | null };
export type InboxPage = { rows: LeadSummary[]; next: InboxCursor | null };
export type InboxColumn = InboxPage & { total: number };
export type InboxBoard = { pipeline: number; columns: Record<string, InboxColumn> };
export type InboxStats = {
  /** Leads con mensajes, sin filtros. */
  total: number;
  /** Con revisión pendiente, sin filtros. */
  review: number;
  /** «Sin responder» del inbox completo (las métricas del topbar no cambian al filtrar). */
  awaiting_all: number;
  /** Pestañas de la lista con los demás filtros aplicados (sin el de la pestaña). */
  etapa: Record<EtapaTab, number>;
  /** Con los filtros aplicados. */
  filtered: number;
  /** «Sin responder» con los filtros aplicados. */
  awaiting: number;
  /** Por pipeline (id, -1 = sin pipeline, -2 = no existe en Kommo), con filtros. */
  pipelines: Record<string, number>;
  /** Valores crudos de leads.channel (se normalizan con normChannel). */
  channels: string[];
  verticals: string[];
};

/** Lo que devuelve GET /api/inbox/leads. */
export type InboxResponse = {
  stats: InboxStats;
  agentCfg: AgentStatusCfg;
  /** Pipelines activos (sin archivados) con sus etapas en el orden de Kommo. */
  pipelines: BoardPipeline[];
} & ({ vista: "tablero"; board: InboxBoard } | { vista: "lista"; list: InboxPage });

// ── URL ──────────────────────────────────────────────────────────────────────

type Params = { get(name: string): string | null };

const oneOf = <T extends string>(list: readonly T[], v: string | null): T | undefined =>
  v != null && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/** Texto libre con tope (la búsqueda no necesita más; evita mandar megas a la base). */
const texto = (v: string | null, max: number) => {
  const t = (v ?? "").trim().slice(0, max);
  return t || undefined;
};

/** Filtros desde la URL. Un valor desconocido se ignora (como el filtro en el navegador de antes). */
export function parseFilters(sp: Params): InboxFilters {
  const f: InboxFilters = {};
  const q = texto(sp.get("q"), 200);
  if (q) f.q = q;
  const channel = texto(sp.get("channel"), 40);
  if (channel) f.channel = channel;
  const vertical = texto(sp.get("vertical"), 120);
  if (vertical) f.vertical = vertical;
  const estado = oneOf(ESTADOS, sp.get("estado"));
  if (estado) f.estado = estado;
  if (sp.get("urgent") === "1") f.urgent = true;
  const rango = oneOf(RANGOS, sp.get("rango"));
  if (rango) f.rango = rango;
  const etapa = oneOf(ETAPAS, sp.get("etapa"));
  if (etapa && etapa !== "todas") f.etapa = etapa;
  return f;
}

/** Pestaña de la lista: la de la URL o «Con agente» (default, no se escribe en la URL). */
export function parseEtapa(sp: Params): EtapaTab {
  return oneOf(ETAPAS, sp.get("etapa")) ?? "agente";
}

export function parseSort(sp: Params): InboxSort {
  return oneOf(SORTS, sp.get("sort")) ?? "recent";
}

export function parseVista(sp: Params): "tablero" | "lista" {
  return sp.get("vista") === "lista" ? "lista" : "tablero";
}

/** Pipeline pedido: id > 0, -1, -2, o null (que elija el servidor). */
export function parsePipeline(sp: Params): number | null {
  const raw = sp.get("pipeline");
  if (raw == null || !/^-?\d{1,18}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 || n === SIN_UBICAR || n === NO_EXISTE ? n : null;
}

/** Etapa de una columna: id > 0, -1 = «otras», null = toda la rebanada (pseudo-pipeline / lista). */
export function parseStage(raw: string | null): number | null {
  if (raw == null || raw === COLUMNA_UNICA) return null;
  if (raw === COLUMNA_OTRAS) return -1;
  if (!/^\d{1,18}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export function parseLimit(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_PAGE) : fallback;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Instante como lo emite la base (to_jsonb(timestamptz)) o ±infinity.
const INSTANTE = /^(-?infinity|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}:\d{2}|Z))$/;
// numeric::text de la base (sin exponente). Sin tope de dígitos propio: una urgencia rara
// del clasificador no puede dejar la paginación trabada en 400 (el largo total sí se acota).
const NUMERO = /^-?\d+(\.\d+)?$/;

/** Cursor de la URL (JSON). undefined = sin cursor; null = cursor inválido (400). */
export function parseCursor(raw: string | null): InboxCursor | undefined | null {
  if (raw == null || raw === "") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { t, id, k } = v as Record<string, unknown>;
  if (typeof t !== "string" || !INSTANTE.test(t)) return null;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (!(k == null || (typeof k === "string" && k.length <= 64 && NUMERO.test(k)))) return null;
  return { t, id, k: (k as string | null | undefined) ?? null };
}

/** Tarjetas ya cargadas por columna (para recargar sin perder los «Ver más»). null = inválido. */
export function parseLimits(raw: string | null): Record<string, number> | undefined | null {
  if (raw == null || raw === "") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (!(k === COLUMNA_OTRAS || k === COLUMNA_UNICA || /^\d{1,18}$/.test(k))) return null;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return null;
    out[k] = Math.min(n, MAX_PAGE);
  }
  return out;
}

/** Querystring de filtros + orden para la API (mismas claves que la URL del inbox). */
export function queryFromFilters(f: InboxFilters, sort: InboxSort): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.channel) p.set("channel", f.channel);
  if (f.vertical) p.set("vertical", f.vertical);
  if (f.estado) p.set("estado", f.estado);
  if (f.urgent) p.set("urgent", "1");
  if (f.rango) p.set("rango", f.rango);
  if (f.etapa) p.set("etapa", f.etapa);
  if (sort !== "recent") p.set("sort", sort);
  return p;
}

// ── Normalización de lo que llega de la base ─────────────────────────────────

/** numeric de Postgres puede llegar como string; todo lo demás ya viene tipado. */
export function normalizeLead(l: LeadSummary): LeadSummary {
  return {
    ...l,
    max_urgency: Number(l.max_urgency) || 0,
    max_toxicity: Number(l.max_toxicity) || 0,
    msg_count: Number(l.msg_count) || 0,
    verticals: l.verticals ?? [],
  };
}

export function normalizePage(p: { rows?: LeadSummary[] | null; next?: InboxCursor | null }): InboxPage {
  return { rows: (p.rows ?? []).map(normalizeLead), next: p.next ?? null };
}

export function normalizeBoard(b: { pipeline: number; columns: Record<string, { total: number } & Parameters<typeof normalizePage>[0]> }): InboxBoard {
  const columns: Record<string, InboxColumn> = {};
  for (const [k, c] of Object.entries(b.columns ?? {})) {
    columns[k] = { total: Number(c.total) || 0, ...normalizePage(c) };
  }
  return { pipeline: Number(b.pipeline), columns };
}

// ── Estado del tablero/lista ─────────────────────────────────────────────────

/** Agrega una página a una columna/lista sin repetir leads (una recarga pudo traer alguno). */
export function appendPage<T extends InboxPage>(cur: T, page: InboxPage): T {
  const seen = new Set(cur.rows.map((r) => r.id));
  return { ...cur, rows: [...cur.rows, ...page.rows.filter((r) => !seen.has(r.id))], next: page.next };
}

/**
 * Cuántas tarjetas pedir por columna al recargar en vivo: las que ya estaban a la vista
 * (con «Ver más» incluidos), nunca menos que una página. Solo las columnas que superan la
 * página por default (el resto usa el default del servidor).
 */
export function boardLimits(board: InboxBoard | null, page = BOARD_PAGE): Record<string, number> {
  const out: Record<string, number> = {};
  if (!board) return out;
  for (const [k, c] of Object.entries(board.columns)) {
    if (c.rows.length > page) out[k] = Math.min(c.rows.length, MAX_PAGE);
  }
  return out;
}

/** Filas a pedir al recargar la lista en vivo (las cargadas, con tope). */
export function listRefreshLimit(list: InboxPage | null, page = LIST_PAGE): number {
  return Math.min(Math.max(list?.rows.length ?? 0, page), MAX_PAGE);
}

/**
 * Recarga en vivo de una lista/columna: la página fresca reemplaza a lo cargado, pero si
 * a la vista había MÁS filas que las que trajo la recarga (un «Ver más»/scroll que terminó
 * mientras la recarga viajaba, o más filas que el tope de recarga), la cola se conserva
 * (sin repetidos) con el cursor viejo: la recarga nunca le recorta la lista a quien la mira.
 */
export function mergeRefresh<T extends InboxPage>(prev: T | null | undefined, fresh: T, alsoFresh?: ReadonlySet<string>): T {
  if (!prev || prev.rows.length <= fresh.rows.length || fresh.next == null) return fresh;
  const seen = new Set(fresh.rows.map((r) => r.id));
  // En el tablero, un lead que la recarga trae en OTRA columna (lo movieron) tampoco se repite.
  for (const id of alsoFresh ?? []) seen.add(id);
  // La cola empieza después de la última fila fresca tal como estaba en lo cargado: si
  // entró un lead nuevo arriba, la que «se cayó» de la ventana fresca no se pierde.
  const lastFresh = fresh.rows[fresh.rows.length - 1];
  const at = lastFresh ? prev.rows.findIndex((r) => r.id === lastFresh.id) : -1;
  const tail = prev.rows.slice(at >= 0 ? at + 1 : fresh.rows.length).filter((r) => !seen.has(r.id));
  return { ...fresh, rows: [...fresh.rows, ...tail], next: prev.next };
}

/** mergeRefresh columna por columna (mismo pipeline); otro pipeline → la recarga manda. */
export function mergeBoardRefresh(prev: InboxBoard | null, fresh: InboxBoard): InboxBoard {
  if (!prev || prev.pipeline !== fresh.pipeline) return fresh;
  const all = new Set(Object.values(fresh.columns).flatMap((c) => c.rows.map((r) => r.id)));
  const columns: Record<string, InboxColumn> = {};
  for (const [k, c] of Object.entries(fresh.columns)) columns[k] = mergeRefresh(prev.columns[k], c, all);
  return { ...fresh, columns };
}

/** Columna del tablero donde está un lead (clave de `columns`), o null si no está cargado. */
export function columnOf(board: InboxBoard, leadId: string): string | null {
  for (const [k, c] of Object.entries(board.columns)) if (c.rows.some((r) => r.id === leadId)) return k;
  return null;
}

/** Lead cargado en el tablero (en cualquier columna). */
export function findLead(board: InboxBoard, leadId: string): LeadSummary | null {
  for (const c of Object.values(board.columns)) {
    const l = c.rows.find((r) => r.id === leadId);
    if (l) return l;
  }
  return null;
}

/** Orden de las tarjetas dentro de una columna (el mismo que aplica la base). */
export function compareLeads(sort: InboxSort, a: LeadSummary, b: LeadSummary): number {
  const ta = a.last_message_at ? Date.parse(a.last_message_at) : -Infinity;
  const tb = b.last_message_at ? Date.parse(b.last_message_at) : -Infinity;
  const byTime = (x: number, y: number) => (x === y ? 0 : x < y ? -1 : 1);
  const desc = byTime(tb, ta) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  if (sort === "oldest") return -desc;
  if (sort === "urgency") return b.max_urgency - a.max_urgency || desc;
  if (sort === "messages") return b.msg_count - a.msg_count || desc;
  return desc;
}

/**
 * Mueve una tarjeta a la columna de `toStage` (optimista, o para respetar un movimiento en curso
 * sobre una recarga que trae la etapa vieja). Ajusta los totales de origen y destino; la tarjeta
 * queda en su lugar según el orden. Si el lead no está cargado o ya está en el destino, no cambia.
 * Si el destino no es una columna del tablero (otro pipeline), la tarjeta solo sale del origen.
 */
export function moveCard(
  board: InboxBoard,
  leadId: string,
  to: { pipeline: number; stage: number },
  sort: InboxSort
): InboxBoard {
  const from = columnOf(board, leadId);
  if (from == null) return board;
  const lead = board.columns[from].rows.find((r) => r.id === leadId)!;
  const toKey = to.pipeline === board.pipeline && board.columns[String(to.stage)] ? String(to.stage) : null;
  if (toKey === from) return board;
  const moved: LeadSummary = { ...lead, kommo_pipeline_id: to.pipeline, kommo_stage_id: to.stage };
  const columns = { ...board.columns };
  const src = columns[from];
  columns[from] = { ...src, rows: src.rows.filter((r) => r.id !== leadId), total: Math.max(0, src.total - 1) };
  if (toKey != null) {
    const dst = columns[toKey];
    const rows = [...dst.rows, moved].sort((a, b) => compareLeads(sort, a, b));
    // Si el destino tiene más páginas y la tarjeta cae después de lo cargado, no se muestra
    // (aparecerá al pedir «Ver más»): mostrarla al final rompería el orden.
    const last = dst.rows[dst.rows.length - 1];
    const visible = dst.next == null || !last || compareLeads(sort, moved, last) <= 0;
    columns[toKey] = { ...dst, rows: visible ? rows : dst.rows, total: dst.total + 1 };
  }
  return { ...board, columns };
}

/**
 * Deshace un movimiento que falló. Si la tarjeta está a la vista, vuelve a su columna. Si no
 * (cayó en el destino después de lo cargado y no se mostraba), se descuenta del destino y se
 * repone en el origen con los datos de antes del movimiento.
 */
export function revertMove(
  board: InboxBoard,
  before: LeadSummary,
  to: { pipeline: number; stage: number },
  sort: InboxSort
): InboxBoard {
  const back = { pipeline: before.kommo_pipeline_id ?? board.pipeline, stage: before.kommo_stage_id ?? -1 };
  if (columnOf(board, before.id) != null) return moveCard(board, before.id, back, sort);
  const columns = { ...board.columns };
  const toKey = to.pipeline === board.pipeline ? String(to.stage) : null;
  if (toKey && columns[toKey]) columns[toKey] = { ...columns[toKey], total: Math.max(0, columns[toKey].total - 1) };
  const fromKey = back.pipeline === board.pipeline && columns[String(back.stage)] ? String(back.stage) : null;
  if (fromKey) {
    const src = columns[fromKey];
    columns[fromKey] = { ...src, rows: [...src.rows, before].sort((a, b) => compareLeads(sort, a, b)), total: src.total + 1 };
  }
  return { ...board, columns };
}

/** Aplica sobre datos frescos los movimientos que siguen en vuelo (la base todavía trae la etapa vieja). */
export function applyPendingMoves(
  board: InboxBoard,
  pending: ReadonlyMap<string, { pipeline: number; stage: number }>,
  sort: InboxSort
): InboxBoard {
  let out = board;
  for (const [leadId, dest] of pending) {
    const lead = findLead(out, leadId);
    if (!lead || (lead.kommo_pipeline_id === dest.pipeline && lead.kommo_stage_id === dest.stage)) continue;
    out = moveCard(out, leadId, dest, sort);
  }
  return out;
}
