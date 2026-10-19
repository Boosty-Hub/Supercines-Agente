import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  decideProcessingFailure,
  errorSummary,
  hasIncomingMessage,
  isMissingColumnError,
  isResumableDuplicate,
  processingLossAlertFor,
  RESUME_MIN_AGE_SECONDS,
  resumeInputsFromStored,
  PROCESSING_BACKOFF_SECONDS,
  PROCESSING_MAX_ATTEMPTS,
  processingFailedAlertFor,
  isFreshResumeMarker,
  processingRetryPatch,
  recoverResumeOrFilter,
  RESUME_CLAIM_ERROR,
  RESUME_RECOVER_GRACE_SECONDS,
  resumeClaimMarker,
} from "./queue-failure.ts";
import { LEAD_RESOLVE_MAX_ATTEMPTS } from "./lead-resolver.ts";
import { ALERT_KINDS } from "./alert-kinds.ts";

Deno.test("decideProcessingFailure: reintenta con backoff creciente y se rinde en el tope", () => {
  const delays: number[] = [];
  for (let a = 1; a < PROCESSING_MAX_ATTEMPTS; a++) {
    const d = decideProcessingFailure({ processingFailures: a });
    assertEquals(d.action, "retry");
    if (d.action === "retry") delays.push(d.delaySeconds);
  }
  assertEquals(delays, [...PROCESSING_BACKOFF_SECONDS].slice(0, PROCESSING_MAX_ATTEMPTS - 1));
  assertEquals([...delays].sort((a, b) => a - b), delays);
  assertEquals(decideProcessingFailure({ processingFailures: PROCESSING_MAX_ATTEMPTS }), { action: "give_up" });
  assertEquals(decideProcessingFailure({ processingFailures: PROCESSING_MAX_ATTEMPTS + 4 }), { action: "give_up" });
  // contador inválido: se trata como primera falla, nunca lanza.
  assertEquals(decideProcessingFailure({ processingFailures: 0 }).action, "retry");
  assertEquals(decideProcessingFailure({ processingFailures: NaN }).action, "retry");
});

Deno.test("el tope de reintentos por excepción cabe en los topes del reaper de claim_inbound_batch (0092)", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/0092_inbound_queue_not_before.sql", import.meta.url));
  const general = Number(sql.match(/v_max_attempts\s+constant\s+int\s*:=\s*(\d+)/)?.[1]);
  const lead = Number(sql.match(/v_lead_max_attempts\s+constant\s+int\s*:=\s*(\d+)/)?.[1]);
  assert(PROCESSING_MAX_ATTEMPTS < general, "el reaper no puede cerrar en silencio una fila que íbamos a reintentar");
  assert(PROCESSING_MAX_ATTEMPTS < lead);
  assertEquals(lead, LEAD_RESOLVE_MAX_ATTEMPTS);
});

Deno.test("hasIncomingMessage: solo mensajes del cliente justifican la alerta", () => {
  assertEquals(hasIncomingMessage({ message: { add: [{ type: "incoming" }] } }), true);
  assertEquals(hasIncomingMessage({ message: { add: [{ type: "outgoing" }] } }), false);
  assertEquals(hasIncomingMessage({ leads: { update: [{ id: 1 }] } }), false);
  assertEquals(hasIncomingMessage({ message: { add: "x" } }), false);
  assertEquals(hasIncomingMessage(null), false);
});

Deno.test("errorSummary: sin texto del cliente (valores entre comillas/paréntesis), acotado", () => {
  const e = new Error('invalid input syntax for type bigint: "Hola, mi cédula es 12345678" Key (kommo_message_id)=(secreto 1) \'otro\' “tipográficas”');
  const s = errorSummary(e);
  assert(!s.includes("cédula") && !s.includes("secreto") && !s.includes("otro") && !s.includes("tipográficas"), s);
  assert(s.startsWith("Error"));
  assert(errorSummary(new Error("x".repeat(5000))).length <= 200);
  assert(errorSummary("texto del cliente: hola").length <= 200);
  assertEquals(errorSummary({ code: "23505", message: "dup" }).includes("23505"), true);
});

Deno.test("processingFailedAlertFor: una por fila, tipo registrado, sin texto del cliente", () => {
  const a = processingFailedAlertFor({
    queueId: "q-1",
    attempts: 3,
    summary: "Error: boom",
    incomingCount: 2,
  });
  assertEquals(a.kind, "inbound_processing_failed");
  assertEquals(a.ref_table, "inbound_queue");
  assertEquals(a.ref_id, "q-1");
  assertEquals(ALERT_KINDS.inbound_processing_failed.webhook, true);
  assertEquals(ALERT_KINDS.inbound_processing_failed.severity, "critical");
  assertEquals((ALERT_KINDS.inbound_processing_failed as { onePerRef?: boolean }).onePerRef, true);
  assertEquals(a.metadata?.motivo, "processing_error");
  assertEquals(a.metadata?.mensajes, 2);
});

Deno.test("isResumableDuplicate: un mensaje insertado pero sin clasificar se retoma; el resto se salta", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const old = new Date(now - (RESUME_MIN_AGE_SECONDS + 1) * 1000).toISOString();
  const base = { lead_id: "L1", direction: "inbound", ignored: false, vertical_id: null, classification: null, inserted_at: old };
  const exp = { leadId: "L1", direction: "inbound", nowMs: now };
  assertEquals(isResumableDuplicate(base, exp), true);
  assertEquals(isResumableDuplicate({ ...base, classification: { error: "x" } }, exp), false);
  assertEquals(isResumableDuplicate({ ...base, vertical_id: "v" }, exp), false);
  assertEquals(isResumableDuplicate({ ...base, ignored: true }, exp), false);
  assertEquals(isResumableDuplicate({ ...base, direction: "outbound" }, exp), false);
});

Deno.test("L2: un duplicado RECIENTE (puede estar clasificándose en otra invocación) no se retoma", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const exp = { leadId: "L1", direction: "inbound", nowMs: now };
  const row = { lead_id: "L1", direction: "inbound", ignored: false, vertical_id: null, classification: null };
  assertEquals(isResumableDuplicate({ ...row, inserted_at: new Date(now - 5_000).toISOString() }, exp), false);
  // Sin fecha de inserción legible (0092 sin aplicar) no se retoma nunca.
  assertEquals(isResumableDuplicate({ ...row, inserted_at: null }, exp), false);
  assertEquals(isResumableDuplicate({ ...row, inserted_at: "basura" }, exp), false);
  // El reintento legítimo de la fila siempre llega con el mensaje más viejo que el umbral.
  assert(RESUME_MIN_AGE_SECONDS < PROCESSING_BACKOFF_SECONDS[0]);
});

Deno.test("SEGURIDAD: un payload hostil que reusa el kommo_message_id de OTRO lead no retoma ese mensaje", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const stored = {
    lead_id: "lead-victima", direction: "inbound", ignored: false, vertical_id: null, classification: null,
    inserted_at: new Date(now - 3_600_000).toISOString(),
  };
  assertEquals(isResumableDuplicate(stored, { leadId: "lead-atacante", direction: "inbound", nowMs: now }), false);
  // Misma lead pero dirección cambiada por el payload: tampoco.
  assertEquals(isResumableDuplicate(stored, { leadId: "lead-victima", direction: "outbound", nowMs: now }), false);
});

Deno.test("SEGURIDAD: al retomar, el texto y el adjunto salen de la fila GUARDADA, nunca del payload nuevo", () => {
  const media = { images: true, documents: true };
  const t = resumeInputsFromStored({ content: "hola, precio?", source: "waba", media_url: null, media_kind: null, media_error: null }, media);
  assertEquals(t, { text: "hola, precio?", channel: "waba", mediaForClassify: null, mediaIgnoreReason: null, hasMedia: false });
  const img = resumeInputsFromStored(
    { content: "[Imagen foto.jpg]", source: "instagram", media_url: "https://cdn.example/a.jpg", media_kind: "image", media_error: null },
    media,
  );
  assertEquals(img.text, "");
  assertEquals(img.mediaForClassify, { kind: "image", label: "Imagen", source: { type: "url", url: "https://cdn.example/a.jpg" } });
  const off = resumeInputsFromStored(
    { content: "[Imagen foto.jpg]", source: "instagram", media_url: "https://cdn.example/a.jpg", media_kind: "image", media_error: null },
    { images: false, documents: true },
  );
  assertEquals(off.mediaForClassify, null);
  assertEquals(off.mediaIgnoreReason, "media_image_off");
  // Audio cuya transcripción no entró: no se re-transcribe; queda con el motivo guardado.
  const audio = resumeInputsFromStored(
    { content: "[Audio a.ogg]", source: "waba", media_url: "https://cdn.example/a.ogg", media_kind: "audio", media_error: "media_audio_transcribe_failed" },
    media,
  );
  assertEquals(audio.text, "");
  assertEquals(audio.mediaIgnoreReason, "media_audio_transcribe_failed");
  // Audio transcripto: el texto guardado (con la transcripción) es el insumo.
  const ok = resumeInputsFromStored(
    { content: "🎙️ quiero turno", source: "waba", media_url: "https://cdn.example/a.ogg", media_kind: "audio", media_error: null },
    media,
  );
  assertEquals(ok.text, "🎙️ quiero turno");
  assertEquals(ok.mediaForClassify, null);
});

Deno.test("M1: el tope por excepción cuenta FALLAS de procesamiento, no claims gastados esperando el lead", () => {
  // Una fila que consumió 6 claims esperando el lead y falla UNA vez: se reintenta.
  assertEquals(decideProcessingFailure({ attempts: 6, processingFailures: 1 }).action, "retry");
  const sql = Deno.readTextFileSync(new URL("../../migrations/0092_inbound_queue_not_before.sql", import.meta.url));
  assert(/add column if not exists processing_failures int not null default 0/.test(sql));
  assert(/returns table \([^)]*processing_failures int[^)]*\)/.test(sql), "claim_inbound_batch devuelve processing_failures");
});

Deno.test("H2: una falla de procesamiento de una fila SIN FIRMA va agregada (inbound_dropped), nunca por fila", () => {
  const args = { queueId: "q-1", attempts: 3, summary: "Error: boom", incomingCount: 1 };
  assertEquals(processingLossAlertFor({ ...args, signed: true }).kind, "inbound_processing_failed");
  const u = processingLossAlertFor({ ...args, signed: false });
  assertEquals(u.kind, "inbound_dropped");
  assertEquals(u.ref_id, undefined);
  assertEquals(u.metadata?.motivo, "processing_error_sin_firma");
  // El reaper aplica la misma regla en SQL.
  const sql = Deno.readTextFileSync(new URL("../../migrations/0092_inbound_queue_not_before.sql", import.meta.url));
  assert(/insert_alert_aggregated\(\s*'inbound_dropped'/.test(sql));
  assert(/add column if not exists signed boolean/.test(sql));
});

Deno.test("L1: falta de columna (función desplegada antes de 0092) se reconoce para caer al UPDATE mínimo", () => {
  assertEquals(isMissingColumnError({ code: "42703", message: "column x does not exist" }), true);
  assertEquals(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'not_before' column" }), true);
  assertEquals(isMissingColumnError({ code: "23505", message: "dup" }), false);
  assertEquals(isMissingColumnError(null), false);
});

Deno.test("L3: el reaper no afirma que el mensaje no entró (pudo insertarse antes de morir)", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/0092_inbound_queue_not_before.sql", import.meta.url));
  assert(!/El mensaje( del cliente)? NO entró/.test(sql), "el reaper no sabe si entró");
  assert(/puede no haber entrado/.test(sql));
  assert(!processingFailedAlertFor({ queueId: "q", attempts: 3, summary: "x", incomingCount: 1 }).description!.includes("NO entró"));
});

Deno.test("M2: 0092 toca alerts ANTES que inbound_queue y acota la espera de locks", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/0092_inbound_queue_not_before.sql", import.meta.url));
  const body = sql.replace(/^--.*$/gm, "");
  assert(/set local lock_timeout = '3s'/.test(body));
  const alertsIdx = body.indexOf("create unique index if not exists alerts_una_por_entidad_v2_uidx");
  const queueIdx = body.indexOf("alter table inbound_queue");
  assert(alertsIdx > 0 && queueIdx > 0 && alertsIdx < queueIdx, `orden: alerts ${alertsIdx} < inbound_queue ${queueIdx}`);
  assert(body.indexOf("lock_timeout") < body.indexOf("delete from public.alerts"));
});

Deno.test("errorSummary: una comilla sin cerrar no filtra lo que sigue", () => {
  const s = errorSummary(new Error('syntax error near "mi tarjeta es 4111 1111'));
  assert(!s.includes("4111"), s);
});

Deno.test("reintento por excepción: vuelve a pending SIN waiting_refs (no la despierta un mensaje del mismo talk)", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const p = processingRetryPatch({ failures: 1, attempts: 2, delaySeconds: 60, summary: "Error: boom", nowMs: now });
  assertEquals(p.status, "pending");
  assertEquals(p.waiting_refs, null);
  assertEquals(p.processing_failures, 1);
  assertEquals(p.claimed_at, null);
  assertEquals(p.not_before, new Date(now + 60_000).toISOString());
  assert(String(p.last_error).startsWith("processing_error"));
  // El backoff de una excepción respeta el mínimo del retomar (no hay atajo).
  assert(PROCESSING_BACKOFF_SECONDS[0] > RESUME_MIN_AGE_SECONDS);
});

Deno.test("marca del retomar con hora: recoverFailedClassifications la saltea mientras es reciente y la toma si el retomar murió", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const m = resumeClaimMarker(now);
  assertEquals(m.error, RESUME_CLAIM_ERROR);
  assertEquals(m.resume_at, new Date(now).toISOString());
  assert(RESUME_RECOVER_GRACE_SECONDS >= 300);
  assertEquals(isFreshResumeMarker(m, now + 1_000), true);
  assertEquals(isFreshResumeMarker(m, now + (RESUME_RECOVER_GRACE_SECONDS - 1) * 1000), true);
  assertEquals(isFreshResumeMarker(m, now + (RESUME_RECOVER_GRACE_SECONDS + 1) * 1000), false);
  // Otros errores (o una marca sin hora legible) no son un retomar en curso.
  assertEquals(isFreshResumeMarker({ error: "classify: boom" }, now), false);
  assertEquals(isFreshResumeMarker({ error: RESUME_CLAIM_ERROR, resume_at: "basura" }, now), false);
  assertEquals(isFreshResumeMarker(null, now), false);
  const cutoff = new Date(now - RESUME_RECOVER_GRACE_SECONDS * 1000).toISOString();
  assertEquals(recoverResumeOrFilter(now), `classification->>resume_at.is.null,classification->>resume_at.lt.${cutoff}`);
});
