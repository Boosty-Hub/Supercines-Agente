// Fallas de PROCESAMIENTO de una fila de inbound_queue (process-inbound).
//
// Antes: si processPayload lanzaba (hipo de la base/PostgREST, Kommo, un bug), la fila pasaba
// directo a 'failed' y sus mensajes se perdían sin reintento ni alerta. Ahora: se devuelve a
// 'pending' con espera (not_before, 0092) hasta PROCESSING_MAX_ATTEMPTS FALLAS (columna
// processing_failures: los claims gastados esperando el lead no cuentan); agotadas, 'failed' +
// alerta `inbound_processing_failed` (una por fila, solo si la fila llegó firmada; sin firma,
// agregada como `inbound_dropped`) si había mensajes del cliente.
//
// Idempotencia del reintento (processPayload se re-ejecuta ENTERO): leads por upsert (23505
// reintenta), posiciones por apply_lead_position (ordenadas), mensajes por kommo_message_id
// único + guarda de duplicados. Un mensaje que quedó insertado pero sin clasificar se RETOMA
// (isResumableDuplicate: mismo lead y dirección, más viejo que RESUME_MIN_AGE_SECONDS, reserva
// condicional) con los insumos de la fila guardada, en vez de saltarse. Nada de esto envía al
// cliente: las respuestas salen solo por generate-response (modo cola, claim_message_batch) →
// reserva de 0071. Costo repetido aceptado: re-consulta a Kommo en el reintento.
import type { AlertInsert } from "./alerts.ts";

/**
 * FALLAS de procesamiento (excepciones) antes de rendirse. Se cuentan en
 * `inbound_queue.processing_failures` (0092), NO en `attempts`: los claims gastados esperando
 * el lead no se comen los reintentos de una excepción. Debe quedar por debajo de los topes del
 * reaper (5 / 7 claims).
 */
export const PROCESSING_MAX_ATTEMPTS = 3;
/** La primera espera es mayor que RESUME_MIN_AGE_SECONDS: el reintento siempre puede retomar. */
export const PROCESSING_BACKOFF_SECONDS = [60, 120, 300] as const;

export type ProcessingDecision = { action: "retry"; delaySeconds: number } | { action: "give_up" };

/**
 * `processingFailures` = fallas de procesamiento de la fila INCLUIDA la actual. `attempts`
 * (claims) se ignora a propósito (M1).
 */
export function decideProcessingFailure(f: { processingFailures: number; attempts?: number }): ProcessingDecision {
  const n = f.processingFailures;
  const a = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  if (a >= PROCESSING_MAX_ATTEMPTS) return { action: "give_up" };
  return { action: "retry", delaySeconds: PROCESSING_BACKOFF_SECONDS[Math.min(a - 1, PROCESSING_BACKOFF_SECONDS.length - 1)] };
}

/**
 * Falta de columna: Postgres 42703 o PostgREST PGRST204 («Could not find the 'x' column»). Una
 * función desplegada antes de 0092 cae al UPDATE mínimo (status, processed_at, last_error) en
 * vez de dejar la fila en 'processing'.
 */
export function isMissingColumnError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42703" || code === "PGRST204";
}

/** ¿El payload trae al menos un mensaje escrito por el cliente? (un saliente perdido no es un cliente sin respuesta). */
export function hasIncomingMessage(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const msg = (payload as Record<string, unknown>).message;
  if (!msg || typeof msg !== "object") return false;
  const add = (msg as Record<string, unknown>).add;
  return Array.isArray(add) && add.some((m) => !!m && typeof m === "object" && (m as Record<string, unknown>).type === "incoming");
}

function incomingCount(payload: unknown): number {
  const add = ((payload as { message?: { add?: unknown } } | null)?.message?.add) as unknown;
  return Array.isArray(add) ? add.filter((m) => !!m && typeof m === "object" && (m as Record<string, unknown>).type === "incoming").length : 0;
}
export { incomingCount };

/**
 * Resumen de un error apto para last_error y alertas (que viajan al webhook): los mensajes de
 * PostgREST/Postgres citan valores ("invalid input syntax…: \"<texto>\"", Key (col)=(valor)), y
 * un valor puede ser texto del cliente. Se quitan los segmentos entre comillas/paréntesis y se acota.
 */
export function errorSummary(err: unknown): string {
  let name = "Error";
  let code = "";
  let message = "";
  if (err instanceof Error) {
    name = err.name || "Error";
    message = err.message;
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") code = c;
  } else if (err && typeof err === "object") {
    const o = err as { code?: unknown; message?: unknown };
    if (typeof o.code === "string") code = o.code;
    if (typeof o.message === "string") message = o.message;
  } else if (typeof err === "string") {
    message = err;
  }
  const MARK = "\u0001";
  let clean = message
    .replace(/"[^"]*"/g, MARK)
    .replace(/“[^”]*”/g, MARK)
    .replace(/'[^']*'/g, MARK)
    .replace(/\([^)]*\)/g, "(…)");
  // Una comilla que quedó sin cerrar: lo que sigue puede ser texto del cliente.
  clean = clean.replace(/["'“”].*$/s, "").split(MARK).join('"…"').replace(/\s+/g, " ").trim();
  // Un mensaje que ES texto libre (error de tipo string) tampoco se cita: solo se conserva si parece técnico.
  const body = typeof err === "string" ? "(texto omitido)" : clean;
  return `${name}${code ? ` [${code}]` : ""}: ${body}`.slice(0, 200);
}

export function processingFailedAlertFor(args: {
  queueId: string;
  attempts: number;
  summary: string;
  incomingCount: number;
}): AlertInsert {
  return {
    kind: "inbound_processing_failed",
    severity: "critical",
    title: "Mensaje perdido: falló el procesamiento de la cola",
    description:
      `El procesamiento de ${args.incomingCount} mensaje(s) de un cliente falló tras ${args.attempts} intentos (${args.summary}). ` +
      "El mensaje puede no haber entrado al sistema: revisalo en Kommo.",
    ref_table: "inbound_queue",
    ref_id: args.queueId,
    metadata: {
      motivo: "processing_error",
      cola_id: args.queueId,
      mensajes: args.incomingCount,
      intentos: args.attempts,
      error: args.summary,
    },
  };
}

/**
 * Pérdida por falla de procesamiento: por fila (`inbound_processing_failed`) solo si la fila
 * llegó FIRMADA; sin firma la pudo forjar cualquiera con la URL del webhook → AGREGADA
 * (`inbound_dropped`, una por ventana; «Anti-inundación»).
 */
export function processingLossAlertFor(args: {
  queueId: string;
  attempts: number;
  summary: string;
  incomingCount: number;
  signed: boolean;
}): AlertInsert {
  if (args.signed) return processingFailedAlertFor(args);
  return {
    kind: "inbound_dropped",
    severity: "critical",
    title: "Se perdió un webhook de Kommo",
    description:
      `El procesamiento de ${args.incomingCount} mensaje(s) de un payload SIN FIRMA falló tras ${args.attempts} intentos (${args.summary}). ` +
      "Puede no haber entrado al sistema: si es real, revisalo en Kommo.",
    ref_table: "inbound_queue",
    metadata: {
      motivo: "processing_error_sin_firma",
      cola_id: args.queueId,
      mensajes: args.incomingCount,
      intentos: args.attempts,
      error: args.summary,
    },
  };
}

/**
 * Edad mínima (desde `messages.inserted_at`, 0092) para retomar un duplicado sin clasificar:
 * más joven puede estar clasificándose en otra invocación (re-entrega de Kommo). Menor que
 * PROCESSING_BACKOFF_SECONDS[0]: el reintento de la propia fila siempre lo encuentra «viejo».
 */
export const RESUME_MIN_AGE_SECONDS = 45;

/**
 * Un mensaje ya insertado (re-entrega del webhook o reintento de la fila) se salta SALVO que
 * haya quedado a medias: entrante, no ignorado, sin vertical y sin clasificación (ni siquiera
 * un error, que recoverFailedClassifications sí ve). Ese se retoma desde la clasificación, pero
 * SOLO si la fila guardada es del MISMO lead y dirección que este payload (el webhook es
 * público: un payload puede reusar el kommo_message_id de otro lead) y fue insertada hace más
 * de RESUME_MIN_AGE_SECONDS. El retomar se reserva además con un UPDATE condicional.
 */
export function isResumableDuplicate(
  row: {
    lead_id?: unknown;
    direction?: unknown;
    ignored?: unknown;
    vertical_id?: unknown;
    classification?: unknown;
    inserted_at?: unknown;
  },
  expected: { leadId: string; direction: string; nowMs: number },
): boolean {
  if (row.lead_id !== expected.leadId || row.direction !== expected.direction) return false;
  if (!(row.direction === "inbound" && row.ignored === false && row.vertical_id == null && row.classification == null)) return false;
  const at = typeof row.inserted_at === "string" ? Date.parse(row.inserted_at) : NaN;
  if (!Number.isFinite(at)) return false;
  return expected.nowMs - at >= RESUME_MIN_AGE_SECONDS * 1000;
}

/** Marca con la que se reserva un retomar (classification.error: si el worker muere, lo ve recoverFailedClassifications). */
export const RESUME_CLAIM_ERROR = "resume: clasificación retomada en curso";

/**
 * Gracia de un retomar EN CURSO: recoverFailedClassifications no toma una marca de retomar más
 * joven que esto (si no, reclasificaba en paralelo el mensaje que el retomar está clasificando).
 * Pasada la gracia el retomar se da por muerto y recover lo toma. Holgado frente a una
 * clasificación (segundos) y menor que la ventana de recuperación.
 */
export const RESUME_RECOVER_GRACE_SECONDS = 300;

/** classification que deja la reserva del retomar: la marca + la hora (resume_at, ISO UTC). */
export function resumeClaimMarker(nowMs: number): { error: string; resume_at: string } {
  return { error: RESUME_CLAIM_ERROR, resume_at: new Date(nowMs).toISOString() };
}

/** ¿Es una marca de retomar con hora legible y más joven que RESUME_RECOVER_GRACE_SECONDS? */
export function isFreshResumeMarker(classification: unknown, nowMs: number): boolean {
  if (!classification || typeof classification !== "object") return false;
  const c = classification as Record<string, unknown>;
  if (c.error !== RESUME_CLAIM_ERROR || typeof c.resume_at !== "string") return false;
  const at = Date.parse(c.resume_at);
  if (!Number.isFinite(at)) return false;
  return nowMs - at < RESUME_RECOVER_GRACE_SECONDS * 1000;
}

/**
 * Filtro PostgREST (`.or(...)`) de recoverFailedClassifications: sin marca de retomar, o con
 * una marca vencida. ISO UTC de toISOString: el orden de texto es el orden temporal.
 */
export function recoverResumeOrFilter(nowMs: number): string {
  const cutoff = new Date(nowMs - RESUME_RECOVER_GRACE_SECONDS * 1000).toISOString();
  return `classification->>resume_at.is.null,classification->>resume_at.lt.${cutoff}`;
}

/**
 * UPDATE del reintento por excepción. Limpia `waiting_refs`: una fila que vuelve por una
 * excepción ya no espera el lead, y si un mensaje del mismo talk la despertara (not_before =
 * ahora) se saltaría la espera, y con ella RESUME_MIN_AGE_SECONDS: el mensaje insertado a medias
 * se vería «joven», no se retomaría y quedaría sin clasificar para siempre.
 */
export function processingRetryPatch(a: {
  failures: number;
  attempts: number;
  delaySeconds: number;
  summary: string;
  nowMs: number;
}): Record<string, unknown> {
  return {
    status: "pending",
    not_before: new Date(a.nowMs + a.delaySeconds * 1000).toISOString(),
    processing_failures: a.failures,
    waiting_refs: null,
    claimed_at: null,
    last_error: `processing_error (falla ${a.failures}, intento ${a.attempts}): ${a.summary}`,
  };
}

const STORED_PLACEHOLDER = /^\[(Imagen|Documento|Audio|Archivo)/;

/**
 * Insumos de la clasificación de un mensaje RETOMADO: salen de la fila GUARDADA (contenido,
 * canal, adjunto), nunca del payload nuevo. No se re-transcribe un audio: si la transcripción
 * entró, ya está en el contenido; si no, queda el motivo guardado.
 */
export function resumeInputsFromStored(
  row: { content?: unknown; source?: unknown; media_url?: unknown; media_kind?: unknown; media_error?: unknown },
  media: { images: boolean; documents: boolean },
): {
  text: string;
  channel: string;
  hasMedia: boolean;
  mediaForClassify: { kind: "image" | "document"; label: string; source: { type: "url"; url: string } } | null;
  mediaIgnoreReason: string | null;
} {
  const content = typeof row.content === "string" ? row.content : "";
  const channel = typeof row.source === "string" && row.source ? row.source : "unknown";
  const kind = typeof row.media_kind === "string" ? row.media_kind : null;
  const url = typeof row.media_url === "string" && /^https?:\/\//i.test(row.media_url) ? row.media_url : null;
  const storedReason = typeof row.media_error === "string" && row.media_error ? row.media_error : null;
  const placeholder = STORED_PLACEHOLDER.test(content);
  const text = placeholder ? "" : content.trim();
  if (!kind) return { text, channel, hasMedia: false, mediaForClassify: null, mediaIgnoreReason: null };
  if ((kind === "image" || kind === "document") && url) {
    const on = kind === "image" ? media.images : media.documents;
    return on
      ? { text, channel, hasMedia: true, mediaForClassify: { kind, label: kind === "image" ? "Imagen" : "Documento", source: { type: "url", url } }, mediaIgnoreReason: null }
      : { text, channel, hasMedia: true, mediaForClassify: null, mediaIgnoreReason: kind === "image" ? "media_image_off" : "media_document_off" };
  }
  if (kind === "audio") {
    return { text, channel, hasMedia: true, mediaForClassify: null, mediaIgnoreReason: placeholder ? (storedReason ?? "media_audio_transcribe_failed") : null };
  }
  return { text, channel, hasMedia: true, mediaForClassify: null, mediaIgnoreReason: storedReason ?? "media_unsupported" };
}
