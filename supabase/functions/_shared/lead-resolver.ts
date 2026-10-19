// _shared/lead-resolver.ts
// Resuelve a qué lead de Kommo pertenece un `message.add` cuando el webhook no trae
// entity_id/element_id, y decide qué hacer con lo que no se pudo resolver.
//
// POR QUÉ (Vitalicia, 2026-10-19): los message.add de origin `onlinechat` llegan con
// chat_id/talk_id/contact_id pero SIN entity_id: Kommo crea el lead DESPUÉS de disparar el
// webhook. Antes process-inbound hacía `if (!Number.isFinite(leadKommoId)) continue` y el
// primer mensaje de una conversación nueva se perdía sin rastro.
//
// Reglas:
//   · La consulta es GET /api/v4/talks/{talk_id} (docs de Kommo: «entity_id int/null,
//     entity_type string/null (lead)», más `_embedded.leads[0].id`). Forma desconocida o
//     entity_type distinto de lead = SIN RESOLVER; nunca se adivina.
//   · Sin resolver NO es descartar: la fila de la cola vuelve a `pending` con espera
//     (`not_before`, migración 0092) solo con esos mensajes, hasta LEAD_RESOLVE_MAX_ATTEMPTS,
//     y deja en `waiting_refs` las conversaciones que espera (talk/chat/contacto, ids validados).
//     Agotado, alerta `inbound_lead_unresolved` (UNA por fila de la cola, ref_id = fila; no
//     agregada: cada pérdida es un cliente sin respuesta). Nunca silencioso. Los motivos que no
//     cambian entre intentos (isPermanentReason) se rinden en el acto, y una fila SIN FIRMA o de
//     forma desconocida avisa AGREGADO (lossAlertMode): el webhook es público.
//   · Cada fila consulta a lo sumo MAX_TALK_LOOKUPS_PER_ROW talks distintos (1 si llegó SIN
//     FIRMA, que además no se reintenta), dentro de TALK_LOOKUP_ROW_BUDGET_MS y del plazo de la
//     corrida (TALK_LOOKUP_RUN_BUDGET_MS, compartido por todas las filas de una invocación), con
//     caché de la corrida (negativos por NEGATIVE_TALK_CACHE_MS).
//   · Un talk que dice contacto/empresa es TRANSITORIO (`talk_other_entity`: Kommo puede estar
//     creando el lead); solo es permanente (`not_lead_entity`, solo log) si lo dice el PAYLOAD.
//     Agotado, `talk_other_entity` alerta agregado.
//   · Un mensaje del MISMO talk/chat que sí trae lead despierta la fila que espera
//     (`wakeRefsFor`: not_before = ahora) para que el primero entre en el mismo lote de
//     respuesta que los siguientes, y generate-response no responde a un lead mientras su
//     contacto tenga una fila esperando (`deferRefsForContact`, tope LEAD_WAIT_DEFER_SECONDS).
//   · Procesar de nuevo es idempotente: messages.kommo_message_id es único y process-inbound
//     descarta los ya insertados; además el reintento lleva SOLO los no resueltos.

import type { AlertInsert } from "./alerts.ts";

/**
 * Intentos totales (claims) de una fila antes de rendirse. La MISMA cifra es
 * `v_lead_max_attempts` del reaper de claim_inbound_batch (0092; lo verifica
 * lead-resolver-sql.test.ts): una fila en espera que muere procesando en su último intento
 * la cierra el reaper CON la alerta, nunca como un `failed` silencioso.
 */
export const LEAD_RESOLVE_MAX_ATTEMPTS = 7;
/**
 * Espera tras el intento N (1-based) antes del siguiente: ~6,75 min en total. La primera es
 * corta: el lead suele aparecer en segundos y el mensaje tiene que entrar antes de que el
 * debounce de generate-response (45 s) responda los que llegaron después.
 */
export const LEAD_RESOLVE_BACKOFF_SECONDS = [5, 10, 30, 60, 120, 180] as const;
/**
 * generate-response no responde a un lead cuyo contacto tiene una fila esperando lead creada
 * hace menos que esto (después responde igual: una espera que no se resuelve no puede dejar
 * al lead sin respuesta; el mensaje tardío se contesta aparte, como antes).
 */
export const LEAD_WAIT_DEFER_SECONDS = 180;

export type MessageLeadRefs = {
  id?: string | number;
  type?: string;
  entity_id?: string | number;
  entity_type?: string | number;
  element_id?: string | number;
  element_type?: string | number;
  talk_id?: string | number;
  chat_id?: string;
  contact_id?: string | number;
};

/**
 * Motivos de «sin resolver». PERMANENTES (no cambian entre intentos: se rinden en el acto, sin
 * reintentos): `no_talk_id` (no hay a quién preguntar), `no_kommo_credentials`,
 * `not_lead_entity` (el PAYLOAD dice que es de un contacto/empresa: no es de un lead) y
 * `talk_lookup_capped` (la fila trae más talks distintos que su cupo). El resto es
 * transitorio: Kommo puede crear el lead o responder en el próximo intento. Incluye
 * `talk_other_entity`: la API de talks dice contacto/empresa pero el payload no (mientras Kommo
 * crea el lead el talk puede apuntar todavía al contacto).
 */
export type UnresolvedReason =
  | "no_talk_id"
  | "no_kommo_credentials"
  | "not_lead_entity"
  | "talk_lookup_capped"
  | "talk_not_found"
  | "talk_without_lead"
  | "talk_lookup_failed"
  | "talk_lookup_budget"
  | "talk_other_entity";

const PERMANENT_REASONS: ReadonlySet<UnresolvedReason> = new Set([
  "no_talk_id",
  "no_kommo_credentials",
  "not_lead_entity",
  "talk_lookup_capped",
]);

export function isPermanentReason(r: UnresolvedReason): boolean {
  return PERMANENT_REASONS.has(r);
}

export type Resolution =
  | { kind: "resolved"; leadId: number; via: "payload" | "talk" }
  // `verifiedContactId`: contact_id que devolvió la API de talks (confirmado por Kommo). El del
  // payload es de un webhook público y no sirve para diferir respuestas de nadie.
  | { kind: "unresolved"; reason: UnresolvedReason; verifiedContactId?: number };

// ---- Acotar las consultas a Kommo (H2/L4: el webhook es público) ----
/**
 * Talks DISTINTOS que se consultan por fila de la cola. Un payload forjado con cientos de
 * mensajes y talk_ids distintos multiplicaba las consultas a Kommo (cuota ~7 req/s compartida
 * con el webhook y el agente) por cada uno de los 7 intentos. Un mensaje real trae uno.
 */
export const MAX_TALK_LOOKUPS_PER_ROW = 5;
/** Tiempo total de consultas de talks por fila (una consulta colgada no se come el wall clock del worker). */
export const TALK_LOOKUP_ROW_BUDGET_MS = 20_000;
/**
 * Tiempo total de consultas de talks de UNA invocación (drainQueue), compartido por todas sus
 * filas: el presupuesto por fila solo no acota un lote de muchas filas (MAX_BATCH × 20 s). Lo
 * que no alcanza a consultarse queda `talk_lookup_budget` (transitorio: se reintenta después).
 */
export const TALK_LOOKUP_RUN_BUDGET_MS = 45_000;
/**
 * Vida de un resultado NEGATIVO en la caché de la corrida. Menor que la primera espera
 * (LEAD_RESOLVE_BACKOFF_SECONDS[0]): un reintento legítimo nunca choca con su propio negativo;
 * solo se deduplican las consultas del mismo talk dentro de una ráfaga.
 */
export const NEGATIVE_TALK_CACHE_MS = 4_000;

type CachedTalk =
  | { ok: true; leadId: number }
  | { ok: false; reason: UnresolvedReason; verifiedContactId?: number; at: number };
/** Caché talk_id → resultado, compartida por las filas de UNA corrida (drainQueue). */
export type TalkCache = Map<number, CachedTalk>;
export function newTalkCache(): TalkCache {
  return new Map();
}

/** Contexto de consultas de UNA fila: caché de la corrida + cupo de talks + presupuesto de tiempo. */
export type TalkLookup = {
  cache: TalkCache;
  looked: Set<number>;
  maxDistinct: number;
  deadlineMs: number;
  now: () => number;
};
/**
 * `signed: false` (fila sin firma: la pudo forjar cualquiera con la URL) → a lo sumo 1 talk.
 * `runDeadlineMs`: plazo de la corrida (TALK_LOOKUP_RUN_BUDGET_MS); el de la fila nunca lo excede.
 */
export function newTalkLookup(
  cache: TalkCache,
  opts: { now?: () => number; budgetMs?: number; maxDistinct?: number; signed?: boolean; runDeadlineMs?: number } = {},
): TalkLookup {
  const now = opts.now ?? Date.now;
  const rowDeadline = now() + (opts.budgetMs ?? TALK_LOOKUP_ROW_BUDGET_MS);
  const run = opts.runDeadlineMs;
  return {
    cache,
    looked: new Set(),
    maxDistinct: opts.maxDistinct ?? (opts.signed === false ? 1 : MAX_TALK_LOOKUPS_PER_ROW),
    deadlineMs: typeof run === "number" && Number.isFinite(run) ? Math.min(rowDeadline, run) : rowDeadline,
    now,
  };
}

/** Id positivo y entero o null. Cadena vacía, 0, NaN, negativos y fracciones no son un id. */
function positiveId(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" && typeof v !== "string") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** `entity_type` del payload: ausente o lead. Otra entidad (contacto, empresa) no es un lead. */
function isLeadEntityType(t: unknown): boolean {
  return t === undefined || t === null || t === "" || t === "lead" || t === "leads";
}

/** `element_type` de Kommo (numérico: 2 = lead, 1 = contacto, 3 = empresa) o su nombre. */
function isLeadElementType(t: unknown): boolean {
  return t === undefined || t === null || t === "" || t === 2 || t === "2" || t === "lead" || t === "leads";
}

/** ¿El payload dice explícitamente que el mensaje es de OTRA entidad (contacto/empresa) con su id? */
function payloadNamesOtherEntity(m: MessageLeadRefs): boolean {
  return (!isLeadEntityType(m.entity_type) && positiveId(m.entity_id) !== null) ||
    (!isLeadElementType(m.element_type) && positiveId(m.element_id) !== null);
}

export function leadIdFromMessage(m: MessageLeadRefs): number | null {
  const byEntity = isLeadEntityType(m.entity_type) ? positiveId(m.entity_id) : null;
  if (byEntity !== null) return byEntity;
  return isLeadElementType(m.element_type) ? positiveId(m.element_id) : null;
}

/** chat_id de Kommo (uuid): solo [A-Za-z0-9-], 1..64. Cualquier otra cosa no es un id. */
function chatId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^[A-Za-z0-9-]{1,64}$/.test(v) ? v : null;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Conversación (talk/chat) de un mensaje, como claves `talk:<id>` / `chat:<id>`. */
export function wakeRefsFor(m: MessageLeadRefs): string[] {
  const out: string[] = [];
  const t = positiveId(m.talk_id);
  if (t !== null) out.push(`talk:${t}`);
  const c = chatId(m.chat_id);
  if (c !== null) out.push(`chat:${c}`);
  return out;
}

/**
 * Tope de despertares por fila en espera (inbound_queue.wake_count, 0094; paridad con
 * `v_max_wakes` de wake_waiting_rows, lo verifica un test).
 */
export const MAX_WAKES_PER_ROW = 3;

/**
 * Refs con las que un mensaje puede DESPERTAR filas en espera. El webhook es público: una fila SIN
 * firma la pudo forjar cualquiera con la URL, y un talk_id ajeno despertaría (y gastaría el
 * backoff de) filas de otras conversaciones. Solo despierta una fila firmada, y solo con mensajes
 * cuyo lead vino del propio payload firmado (`via: "payload"`) o lo confirmó la API de talks
 * (`via: "talk"`).
 */
export function wakeRefsForTrusted(
  m: MessageLeadRefs,
  ctx: { signed: boolean; via: "payload" | "talk" },
): string[] {
  if (ctx.signed !== true) return [];
  if (ctx.via !== "payload" && ctx.via !== "talk") return [];
  return wakeRefsFor(m);
}

/**
 * Lo que una fila en espera deja en `inbound_queue.waiting_refs`: talk y chat (solo despiertan
 * la fila) y los contactos VERIFICADOS por la API de Kommo (los únicos que difieren respuestas).
 */
export function waitingRefsFor(messages: MessageLeadRefs[], verifiedContactIds: number[] = []): string[] {
  const out: string[] = [];
  for (const m of messages) out.push(...wakeRefsFor(m));
  for (const c of verifiedContactIds) {
    const ct = positiveId(c);
    if (ct !== null) out.push(`contact:${ct}`);
  }
  return uniq(out);
}

/**
 * ¿generate-response debe esperar a una fila de la cola que aguarda el lead de este contacto?
 * Tope duro medido desde el mensaje sin responder MÁS VIEJO del lead: filas nuevas no lo
 * extienden (un atacante no puede diferir indefinidamente la respuesta de otro).
 */
export function shouldDeferForWaitingRow(a: { nowMs: number; oldestUnansweredMs: number; hasWaitingRow: boolean }): boolean {
  if (!a.hasWaitingRow) return false;
  if (!Number.isFinite(a.oldestUnansweredMs)) return false;
  const age = a.nowMs - a.oldestUnansweredMs;
  return age >= 0 && age < LEAD_WAIT_DEFER_SECONDS * 1000;
}

/** Posiciones válidas del desempate de created_at: más allá no hay payload legítimo (1 MB). */
export const MAX_ORDER_INDEX = 999;

/**
 * El webhook es público: `_orig_idx` solo lo escribe NUESTRO reencolado (retryPayload). Todo
 * lo que llega de fuera se limpia antes de encolar, o un atacante movería created_at.
 */
export function stripOrderMarkers<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  const { _orig_idx: _drop, ...rest } = p;
  void _drop;
  const msg = rest.message;
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    const add = (msg as Record<string, unknown>).add;
    if (Array.isArray(add)) {
      rest.message = {
        ...(msg as Record<string, unknown>),
        add: add.map((m) => {
          if (!m || typeof m !== "object" || Array.isArray(m)) return m;
          const { _orig_idx: _d, ...keep } = m as Record<string, unknown>;
          void _d;
          return keep;
        }),
      };
    }
  }
  return rest as T;
}

/**
 * Prefijo de `inbound_queue.last_error` de una fila que vuelve a `pending` ESPERANDO el lead
 * (closeQueueRow). Lo usa el despertar para no tocar otra cosa.
 */
export const WAKE_LAST_ERROR_PREFIX = "lead_unresolved";

type WakeQuery<Q> = {
  eq(col: string, v: unknown): Q;
  overlaps(col: string, v: string[]): Q;
  gt(col: string, v: string): Q;
  like(col: string, pattern: string): Q;
};

/**
 * Filtro del despertar (wakeWaitingRows): SOLO filas que siguen esperando el lead — pending, sin
 * fallas de procesamiento (processing_failures = 0) y con last_error de espera de lead. Una fila
 * que vuelve por una EXCEPCIÓN espera su backoff (> RESUME_MIN_AGE_SECONDS): despertarla antes
 * dejaba el mensaje insertado a medias «joven» para el retomar y sin clasificar para siempre.
 */
export function applyWakeFilter<Q extends WakeQuery<Q>>(q: Q, refs: string[], nowIso: string): Q {
  return q
    .eq("status", "pending")
    .eq("processing_failures", 0)
    .like("last_error", `${WAKE_LAST_ERROR_PREFIX}%`)
    .overlaps("waiting_refs", refs)
    .gt("not_before", nowIso);
}

/** Clave con la que generate-response busca una fila que espera al contacto de un lead. */
export function deferRefsForContact(contactId: unknown): string[] {
  const ct = positiveId(contactId);
  return ct === null ? [] : [`contact:${ct}`];
}

/**
 * Posición del mensaje en el payload ORIGINAL (para el desempate de created_at). El reintento
 * lleva solo los no resueltos y los anota con `_orig_idx`; sin eso un mensaje reintentado
 * cambiaba de índice y podía empatar con otro del mismo payload.
 */
export function messageOrderIndex(m: { _orig_idx?: unknown }, idx: number): number {
  const o = m._orig_idx;
  const v = typeof o === "number" && Number.isInteger(o) && o >= 0 ? o : idx;
  return Math.min(v, MAX_ORDER_INDEX);
}

/** Lee el lead de la respuesta de GET /api/v4/talks/{id}. Forma desconocida = null. */
export function leadIdFromTalk(json: unknown): number | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const t = json as Record<string, unknown>;
  const type = t.entity_type;
  if (type === undefined || type === null || type === "lead" || type === "leads") {
    const direct = positiveId(t.entity_id);
    if (direct !== null) return direct;
  } else {
    // entity_type presente y distinto de lead: no se toma esa entidad por lead.
    return null;
  }
  const embedded = t._embedded;
  if (embedded && typeof embedded === "object") {
    const leads = (embedded as Record<string, unknown>).leads;
    if (Array.isArray(leads) && leads.length > 0 && leads[0] && typeof leads[0] === "object") {
      return positiveId((leads[0] as Record<string, unknown>).id);
    }
  }
  return null;
}

/** entity_type del talk presente y distinto de lead: la conversación no es de un lead. */
function talkNamesOtherEntity(json: unknown): boolean {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const type = (json as Record<string, unknown>).entity_type;
  return !(type === undefined || type === null || type === "" || type === "lead" || type === "leads");
}

const BUDGET_EXHAUSTED = Symbol("budget");

/**
 * `fetchTalk(talkId, signal)` devuelve el JSON del talk, `null` si no existe (404) o lanza ante
 * un error (red / HTTP / 429 agotado). `null` en lugar de la función = sin credenciales de Kommo.
 * `lookup` (newTalkLookup) acota la fila: caché de la corrida (positivos; negativos por
 * NEGATIVE_TALK_CACHE_MS), MAX_TALK_LOOKUPS_PER_ROW talks distintos y TALK_LOOKUP_ROW_BUDGET_MS
 * de tiempo total (la consulta en curso se aborta al vencer).
 */
export async function resolveLeadId(
  m: MessageLeadRefs,
  fetchTalk: ((talkId: number, signal?: AbortSignal) => Promise<unknown | null>) | null,
  lookup: TalkLookup = newTalkLookup(newTalkCache()),
): Promise<Resolution> {
  const direct = leadIdFromMessage(m);
  if (direct !== null) return { kind: "resolved", leadId: direct, via: "payload" };

  const talkId = positiveId(m.talk_id);
  if (talkId === null) {
    return { kind: "unresolved", reason: payloadNamesOtherEntity(m) ? "not_lead_entity" : "no_talk_id" };
  }
  if (!fetchTalk) return { kind: "unresolved", reason: "no_kommo_credentials" };

  const cached = lookup.cache.get(talkId);
  if (cached?.ok) return { kind: "resolved", leadId: cached.leadId, via: "talk" };
  if (cached && lookup.now() - cached.at < NEGATIVE_TALK_CACHE_MS) {
    return cached.verifiedContactId === undefined
      ? { kind: "unresolved", reason: cached.reason }
      : { kind: "unresolved", reason: cached.reason, verifiedContactId: cached.verifiedContactId };
  }
  if (!lookup.looked.has(talkId) && lookup.looked.size >= lookup.maxDistinct) {
    return { kind: "unresolved", reason: "talk_lookup_capped" };
  }
  const remaining = lookup.deadlineMs - lookup.now();
  if (remaining <= 0) return { kind: "unresolved", reason: "talk_lookup_budget" };
  lookup.looked.add(talkId);

  const negative = (reason: UnresolvedReason, verifiedContactId?: number): Resolution => {
    // Solo lo que dijo Kommo se cachea (un corte por presupuesto o un error de red, no).
    if (reason !== "talk_lookup_budget" && reason !== "talk_lookup_failed") {
      lookup.cache.set(talkId, { ok: false, reason, verifiedContactId, at: lookup.now() });
    }
    return verifiedContactId === undefined
      ? { kind: "unresolved", reason }
      : { kind: "unresolved", reason, verifiedContactId };
  };

  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let json: unknown | null;
  try {
    const call = fetchTalk(talkId, ctrl.signal);
    call.catch(() => {}); // si gana el presupuesto, el rechazo tardío no queda sin manejar
    const out = await Promise.race([
      call,
      new Promise<typeof BUDGET_EXHAUSTED>((res) => {
        timer = setTimeout(() => res(BUDGET_EXHAUSTED), remaining);
      }),
    ]);
    if (out === BUDGET_EXHAUSTED) {
      ctrl.abort();
      lookup.deadlineMs = lookup.now(); // la fila no consulta nada más en este intento
      console.warn(`resolveLeadId talk ${talkId}: presupuesto de tiempo de la fila agotado`);
      return negative("talk_lookup_budget");
    }
    json = out;
  } catch (err) {
    console.warn(`resolveLeadId talk ${talkId}:`, err instanceof Error ? err.message : String(err));
    return negative("talk_lookup_failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (json === null || json === undefined) return negative("talk_not_found");
  const leadId = leadIdFromTalk(json);
  if (leadId === null) {
    // El talk dice contacto/empresa: si el payload también, no es de un lead (permanente); si
    // no, Kommo puede estar creando el lead todavía (transitorio).
    if (talkNamesOtherEntity(json)) return negative(payloadNamesOtherEntity(m) ? "not_lead_entity" : "talk_other_entity");
    const tc = json && typeof json === "object" ? positiveId((json as Record<string, unknown>).contact_id) : null;
    return negative("talk_without_lead", tc === null ? undefined : tc);
  }
  lookup.cache.set(talkId, { ok: true, leadId });
  return { kind: "resolved", leadId, via: "talk" };
}

export type UnresolvedDecision = { action: "retry"; delaySeconds: number } | { action: "give_up" };

/** `attempts` = intentos ya consumidos por la fila (el claim ya sumó el actual). */
export function decideUnresolved(attempts: number): UnresolvedDecision {
  if (attempts >= LEAD_RESOLVE_MAX_ATTEMPTS) return { action: "give_up" };
  const i = Math.max(0, Math.min(attempts - 1, LEAD_RESOLVE_BACKOFF_SECONDS.length - 1));
  return { action: "retry", delaySeconds: LEAD_RESOLVE_BACKOFF_SECONDS[i] };
}

/**
 * Payload del reintento: solo los mensajes sin resolver (los demás ya se procesaron), cada uno
 * con su posición en el payload original (`_orig_idx`, ver messageOrderIndex).
 */
export function retryPayload<M extends object>(
  payload: { account?: unknown },
  unresolved: Array<{ message: M; index: number }>,
): { account?: unknown; message: { add: Array<M & { _orig_idx: number }> } } {
  const add = unresolved.map((u) => ({ ...u.message, _orig_idx: u.index }));
  if (payload.account !== undefined) return { account: payload.account, message: { add } };
  return { message: { add } };
}

export type LossAlertMode = "per_row" | "aggregated" | "log";

/**
 * Cómo se avisa la pérdida de un mensaje del cliente. Por fila (`inbound_lead_unresolved`,
 * crítica) SOLO si la fila llegó FIRMADA (webhook con el token: la manda Kommo) y el motivo es
 * una conversación de lead que no se pudo ubicar. Una fila sin firma la pudo forjar cualquiera
 * con la URL: va AGREGADA (`inbound_dropped`, una por ventana; «Anti-inundación»). Un payload
 * sin talk/ids (forma desconocida) o con un talk que excede el cupo: agregada. Una conversación
 * que no es de un lead no es un mensaje para el agente: solo log.
 */
export function lossAlertMode(reason: UnresolvedReason, signed: boolean): LossAlertMode {
  if (reason === "not_lead_entity") return "log";
  if (!signed) return "aggregated";
  // talk_other_entity: Kommo dijo contacto/empresa hasta el final; puede no ser de un lead → agregada.
  if (reason === "no_talk_id" || reason === "talk_lookup_capped" || reason === "talk_other_entity") return "aggregated";
  return "per_row";
}

export type UnresolvedItem<M extends MessageLeadRefs = MessageLeadRefs> = {
  message: M;
  reason: UnresolvedReason;
  index: number;
  verifiedContactId?: number;
};

export type UnresolvedPlan<M extends MessageLeadRefs> = {
  /** Se reintentan (transitorios, con intentos disponibles). */
  retry: UnresolvedItem<M>[];
  delaySeconds?: number;
  /** Se descartan ahora (permanentes, o transitorios con los intentos agotados). */
  givenUp: UnresolvedItem<M>[];
  /** De lo descartado, mensajes del CLIENTE según cómo se avisa. */
  perRow: UnresolvedItem<M>[];
  aggregated: UnresolvedItem<M>[];
  logOnly: UnresolvedItem<M>[];
};

/**
 * Decide, mensaje por mensaje, qué se reintenta y cómo se avisa lo que se pierde. Una fila SIN
 * FIRMA no se reintenta (cada reintento repetiría consultas a Kommo por un payload que pudo
 * forjar cualquiera): se rinde en el primer intento, con alerta agregada.
 */
export function planUnresolved<M extends MessageLeadRefs>(args: {
  attempts: number;
  signed: boolean;
  unresolved: UnresolvedItem<M>[];
}): UnresolvedPlan<M> {
  const decision = decideUnresolved(args.attempts);
  const retry: UnresolvedItem<M>[] = [];
  const givenUp: UnresolvedItem<M>[] = [];
  for (const u of args.unresolved) {
    if (args.signed && decision.action === "retry" && !isPermanentReason(u.reason)) retry.push(u);
    else givenUp.push(u);
  }
  const lost = givenUp.filter((u) => u.message.type === "incoming");
  const by = (mode: LossAlertMode) => lost.filter((u) => lossAlertMode(u.reason, args.signed) === mode);
  return {
    retry,
    ...(retry.length > 0 && decision.action === "retry" ? { delaySeconds: decision.delaySeconds } : {}),
    givenUp,
    perRow: by("per_row"),
    aggregated: by("aggregated"),
    logOnly: by("log"),
  };
}

/**
 * Alerta AGREGADA (`inbound_dropped`, una fila por ventana de 15 min: insert_alert_aggregated)
 * para pérdidas que no justifican una crítica por fila: payload sin firma (lo pudo forjar
 * cualquiera) o de forma desconocida. Sin ref_id ni texto del cliente; solo ids validados.
 */
export function aggregatedLossAlertFor(args: {
  queueId: string;
  attempts: number;
  signed: boolean;
  unresolved: Array<{ message: MessageLeadRefs; reason: UnresolvedReason }>;
}): AlertInsert {
  const otherEntity = args.signed && args.unresolved.length > 0 && args.unresolved.every((u) => u.reason === "talk_other_entity");
  const what = !args.signed
    ? "SIN FIRMA (sin el token del webhook)"
    : otherEntity
      ? "cuya conversación Kommo asocia a un contacto/empresa (no a un lead)"
      : "de forma desconocida";
  return {
    kind: "inbound_dropped",
    severity: "critical",
    title: "Se perdió un webhook de Kommo",
    description:
      `${args.unresolved.length} mensaje(s) de un payload ${what} ` +
      "llegaron sin lead y no se pudieron ubicar en Kommo. Si son reales, revisalos en Kommo; si se repiten sin firma, pasá el webhook a estricto.",
    ref_table: "inbound_queue",
    metadata: {
      motivo: !args.signed ? "lead_unresolved_sin_firma" : otherEntity ? "lead_unresolved_entidad_no_lead" : "lead_unresolved_forma_desconocida",
      cola_id: args.queueId,
      mensajes: args.unresolved.length,
      intentos: args.attempts,
      razones: [...new Set(args.unresolved.map((u) => u.reason))],
    },
  };
}

/**
 * Alerta al agotar los intentos: tipo propio `inbound_lead_unresolved`, UNA por fila de la cola
 * (ref_id = fila, índice único de 0092). No incluye texto del cliente (las alertas viajan al
 * webhook) y solo ids VALIDADOS (nada crudo del payload).
 */
export function droppedAlertFor(args: {
  queueId: string;
  attempts: number;
  unresolved: Array<{ message: MessageLeadRefs; reason: UnresolvedReason }>;
}): AlertInsert {
  const ids = <T>(f: (m: MessageLeadRefs) => T | null): T[] => [
    ...new Set(args.unresolved.map((u) => f(u.message)).filter((x): x is T => x !== null)),
  ];
  return {
    kind: "inbound_lead_unresolved",
    severity: "critical",
    title: "Mensaje sin lead: no se pudo ubicar la conversación en Kommo",
    description:
      `${args.unresolved.length} mensaje(s) llegaron sin lead asociado y Kommo no lo creó tras ${args.attempts} intentos. ` +
      "El mensaje del cliente NO entró al sistema: revisalo en Kommo.",
    ref_table: "inbound_queue",
    ref_id: args.queueId,
    metadata: {
      motivo: "lead_unresolved",
      cola_id: args.queueId,
      mensajes: args.unresolved.length,
      intentos: args.attempts,
      razones: args.unresolved.map((u) => u.reason),
      talk_ids: ids((m) => positiveId(m.talk_id)),
      chat_ids: ids((m) => chatId(m.chat_id)),
      contact_ids: ids((m) => positiveId(m.contact_id)),
    },
  };
}
