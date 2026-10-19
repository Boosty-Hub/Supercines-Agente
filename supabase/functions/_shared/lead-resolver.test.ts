import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  aggregatedLossAlertFor,
  decideUnresolved,
  isPermanentReason,
  MAX_TALK_LOOKUPS_PER_ROW,
  NEGATIVE_TALK_CACHE_MS,
  newTalkCache,
  newTalkLookup,
  applyWakeFilter,
  TALK_LOOKUP_RUN_BUDGET_MS,
  WAKE_LAST_ERROR_PREFIX,
  planUnresolved,
  TALK_LOOKUP_ROW_BUDGET_MS,
  type UnresolvedReason,
  deferRefsForContact,
  droppedAlertFor,
  LEAD_RESOLVE_BACKOFF_SECONDS,
  LEAD_WAIT_DEFER_SECONDS,
  LEAD_RESOLVE_MAX_ATTEMPTS,
  leadIdFromMessage,
  leadIdFromTalk,
  MAX_ORDER_INDEX,
  messageOrderIndex,
  shouldDeferForWaitingRow,
  stripOrderMarkers,
  resolveLeadId,
  retryPayload,
  waitingRefsFor,
  wakeRefsFor,
  wakeRefsForTrusted,
  MAX_WAKES_PER_ROW,
} from "./lead-resolver.ts";

// Forma REAL (Vitalicia, 2026-10-19): message.add de origin onlinechat llega SIN
// entity_id/element_id porque Kommo crea el lead DESPUÉS de disparar el webhook.
const onlinechat = {
  id: "abc-123",
  type: "incoming" as const,
  origin: "onlinechat",
  text: "Hola, quiero información",
  chat_id: "f1a2b3c4-chat",
  talk_id: "9001",
  contact_id: "7777",
  author: { id: "x", name: "Visitante" },
};

Deno.test("leadIdFromMessage: entity_id, element_id; vacío o inválido = null", () => {
  assertEquals(leadIdFromMessage({ ...onlinechat, entity_id: "555" }), 555);
  assertEquals(leadIdFromMessage({ ...onlinechat, element_id: "556" }), 556);
  assertEquals(leadIdFromMessage(onlinechat), null);
  assertEquals(leadIdFromMessage({ ...onlinechat, entity_id: "" }), null);
  assertEquals(leadIdFromMessage({ ...onlinechat, entity_id: "abc" }), null);
  assertEquals(leadIdFromMessage({ ...onlinechat, entity_id: "0" }), null);
});

Deno.test("leadIdFromTalk: entity_id con entity_type lead, o _embedded.leads[0]", () => {
  assertEquals(leadIdFromTalk({ talk_id: 9001, entity_id: 42, entity_type: "lead" }), 42);
  assertEquals(leadIdFromTalk({ talk_id: 9001, entity_id: 42 }), 42);
  assertEquals(leadIdFromTalk({ entity_id: null, entity_type: null, _embedded: { leads: [{ id: 43 }] } }), 43);
  assertEquals(leadIdFromTalk({ entity_id: null, entity_type: null }), null);
  // Una entidad que no es lead jamás se toma por lead.
  assertEquals(leadIdFromTalk({ entity_id: 42, entity_type: "contact" }), null);
  // Formas desconocidas = sin resolver, nunca adivinar.
  assertEquals(leadIdFromTalk(null), null);
  assertEquals(leadIdFromTalk("x"), null);
  assertEquals(leadIdFromTalk([]), null);
  assertEquals(leadIdFromTalk({ entity_id: "no-es-numero", entity_type: "lead" }), null);
  assertEquals(leadIdFromTalk({ _embedded: { leads: "raro" } }), null);
});

Deno.test("resolveLeadId: con entity_id no consulta a Kommo", async () => {
  let calls = 0;
  const r = await resolveLeadId({ ...onlinechat, entity_id: "555" }, async () => { calls++; return null; });
  assertEquals(r, { kind: "resolved", leadId: 555, via: "payload" });
  assertEquals(calls, 0);
});

Deno.test("resolveLeadId: sin entity_id resuelve por talk_id", async () => {
  const asked: number[] = [];
  const r = await resolveLeadId(onlinechat, async (id) => { asked.push(id); return { entity_id: 8080, entity_type: "lead" }; });
  assertEquals(r, { kind: "resolved", leadId: 8080, via: "talk" });
  assertEquals(asked, [9001]);
});

Deno.test("resolveLeadId: cachea por talk_id dentro de la misma corrida", async () => {
  let calls = 0;
  const cache = newTalkCache();
  const fetchTalk = async () => { calls++; return { entity_id: 8080, entity_type: "lead" }; };
  await resolveLeadId(onlinechat, fetchTalk, newTalkLookup(cache));
  await resolveLeadId({ ...onlinechat, id: "otro" }, fetchTalk, newTalkLookup(cache));
  assertEquals(calls, 1);
});

Deno.test("resolveLeadId: talk aún sin lead (Kommo no lo creó) = sin resolver", async () => {
  const r = await resolveLeadId(onlinechat, async () => ({ talk_id: 9001, entity_id: null, entity_type: null }));
  assertEquals(r, { kind: "unresolved", reason: "talk_without_lead" });
});

Deno.test("resolveLeadId: talk inexistente (404 → null) o forma rara = sin resolver", async () => {
  assertEquals(await resolveLeadId(onlinechat, async () => null), { kind: "unresolved", reason: "talk_not_found" });
  assertEquals(await resolveLeadId(onlinechat, async () => ({ foo: 1 })), { kind: "unresolved", reason: "talk_without_lead" });
});

Deno.test("resolveLeadId: error de red/HTTP en la consulta = sin resolver, no lanza", async () => {
  const r = await resolveLeadId(onlinechat, async () => { throw new Error("429 agotado"); });
  assertEquals(r, { kind: "unresolved", reason: "talk_lookup_failed" });
});

Deno.test("resolveLeadId: sin talk_id (solo chat_id/contact_id) no hay a quién preguntar", async () => {
  let calls = 0;
  const { talk_id: _t, ...sinTalk } = onlinechat;
  const r = await resolveLeadId(sinTalk, async () => { calls++; return null; });
  assertEquals(r, { kind: "unresolved", reason: "no_talk_id" });
  assertEquals(calls, 0);
});

Deno.test("resolveLeadId: sin cliente de Kommo (credenciales) = sin resolver", async () => {
  const r = await resolveLeadId(onlinechat, null);
  assertEquals(r, { kind: "unresolved", reason: "no_kommo_credentials" });
});

Deno.test("decideUnresolved: reintenta con espera creciente y se rinde en el tope", () => {
  const a1 = decideUnresolved(1);
  assertEquals(a1.action, "retry");
  const delays: number[] = [];
  for (let i = 1; i < LEAD_RESOLVE_MAX_ATTEMPTS; i++) {
    const d = decideUnresolved(i);
    assertEquals(d.action, "retry");
    if (d.action === "retry") delays.push(d.delaySeconds);
  }
  // Crece, la PRIMERA espera es corta (el lead suele aparecer en segundos y el mensaje tiene
  // que entrar antes de que el debounce de 45 s responda los siguientes) y el total queda
  // por debajo de 7 minutos.
  assertEquals([...delays].sort((a, b) => a - b), delays);
  assertEquals(delays[0], 5);
  assertEquals(delays, [...LEAD_RESOLVE_BACKOFF_SECONDS]);
  assertEquals(delays.length, LEAD_RESOLVE_MAX_ATTEMPTS - 1);
  const total = delays.reduce((a, b) => a + b, 0);
  assertEquals(total < 7 * 60, true);
  assertEquals(decideUnresolved(LEAD_RESOLVE_MAX_ATTEMPTS), { action: "give_up" });
  assertEquals(decideUnresolved(LEAD_RESOLVE_MAX_ATTEMPTS + 3), { action: "give_up" });
});

Deno.test("retryPayload: conserva SOLO los mensajes sin resolver, sin leads ni los ya procesados", () => {
  const payload = {
    account: { subdomain: "vitalicia" },
    leads: { add: [{ id: "1" }], update: [{ id: "2" }] },
    message: { add: [{ ...onlinechat, entity_id: "555", id: "ya-procesado" }, onlinechat] },
  };
  const out = retryPayload(payload, [{ message: onlinechat, index: 1 }]);
  assertEquals(out, { account: { subdomain: "vitalicia" }, message: { add: [{ ...onlinechat, _orig_idx: 1 }] } });
});

Deno.test("retryPayload + messageOrderIndex: el reintento conserva la posición ORIGINAL (sin empates de created_at)", () => {
  // Payload original [a, b, c]: b se resolvió, a y c no. El reintento lleva [a, c]; sin el índice
  // original c pasaría a índice 1 y empataría con b (mismo queuedAt + 1 ms).
  const a = { ...onlinechat, id: "a" }, c = { ...onlinechat, id: "c" };
  const out = retryPayload({}, [{ message: a, index: 0 }, { message: c, index: 2 }]);
  assertEquals(out.message.add.map((m, i) => messageOrderIndex(m, i)), [0, 2]);
  // Un segundo reintento (ya reducido) no pierde el índice original.
  const again = retryPayload({}, [{ message: out.message.add[1], index: messageOrderIndex(out.message.add[1], 1) }]);
  assertEquals(messageOrderIndex(again.message.add[0], 0), 2);
  // Sin anotación (o basura) se usa el índice del payload.
  assertEquals(messageOrderIndex({ _orig_idx: "x" }, 3), 3);
  assertEquals(messageOrderIndex({ _orig_idx: -1 }, 3), 3);
  assertEquals(messageOrderIndex({}, 4), 4);
});

Deno.test("leadIdFromMessage: entity_id de una entidad que NO es lead se ignora", () => {
  assertEquals(leadIdFromMessage({ ...onlinechat, entity_id: "555", entity_type: "lead" }), 555);
  assertEquals(leadIdFromMessage({ ...onlinechat, entity_id: "555", entity_type: "leads" }), 555);
  assertEquals(leadIdFromMessage({ ...onlinechat, entity_id: "555", entity_type: "contact" }), null);
  assertEquals(leadIdFromMessage({ ...onlinechat, entity_id: "555", entity_type: "company" }), null);
  // element_type de Kommo: 2 = lead; 1 = contacto.
  assertEquals(leadIdFromMessage({ ...onlinechat, element_id: "556", element_type: "2" }), 556);
  assertEquals(leadIdFromMessage({ ...onlinechat, element_id: "556", element_type: 2 }), 556);
  assertEquals(leadIdFromMessage({ ...onlinechat, element_id: "556", element_type: "1" }), null);
  // Un entity de contacto no tapa un element que sí es lead.
  assertEquals(leadIdFromMessage({ ...onlinechat, entity_id: "9", entity_type: "contact", element_id: "556", element_type: "2" }), 556);
});

Deno.test("waitingRefsFor / wakeRefsFor: solo ids VALIDADOS de talk, chat y contacto", () => {
  // El contact_id del PAYLOAD no es de fiar (webhook público): solo entra el verificado por la API.
  assertEquals(waitingRefsFor([onlinechat]), ["talk:9001", "chat:f1a2b3c4-chat"]);
  assertEquals(waitingRefsFor([onlinechat], [7777]), ["talk:9001", "chat:f1a2b3c4-chat", "contact:7777"]);
  assertEquals(waitingRefsFor([onlinechat], [-1, 0, 1.5 as number]), ["talk:9001", "chat:f1a2b3c4-chat"]);
  // Sin repetidos entre varios mensajes de la misma conversación.
  assertEquals(waitingRefsFor([onlinechat, { ...onlinechat, id: "2" }], [7777, 7777]), ["talk:9001", "chat:f1a2b3c4-chat", "contact:7777"]);
  // Valores inválidos no se guardan (ni se usan para despertar).
  assertEquals(waitingRefsFor([{ talk_id: "abc", chat_id: "x y'; drop", contact_id: "-3" }]), []);
  assertEquals(waitingRefsFor([{ chat_id: "a".repeat(200) }]), []);
  // Despertar: talk y chat (el contacto puede tener otras conversaciones).
  assertEquals(wakeRefsFor({ ...onlinechat, entity_id: "555" }), ["talk:9001", "chat:f1a2b3c4-chat"]);
  assertEquals(wakeRefsFor({ entity_id: "555" }), []);
  assertEquals(deferRefsForContact(7777), ["contact:7777"]);
  assertEquals(deferRefsForContact(null), []);
  assertEquals(deferRefsForContact(0), []);
});

Deno.test("droppedAlertFor: tipo propio (no agregado), UNA por fila de la cola, sin texto del cliente", () => {
  const a = droppedAlertFor({
    queueId: "q1",
    attempts: 7,
    unresolved: [{ message: onlinechat, reason: "talk_without_lead" }],
  });
  // No es inbound_dropped: ese tipo se agrega por ventana (una fila por 15 min con el ÚLTIMO
  // detalle) y mezclaba motivos y perdía el talk de cada pérdida.
  assertEquals(a.kind, "inbound_lead_unresolved");
  assertEquals(a.ref_table, "inbound_queue");
  assertEquals(a.ref_id, "q1");
  assertEquals(a.metadata?.motivo, "lead_unresolved");
  assertEquals(a.metadata?.mensajes, 1);
  assertEquals(a.metadata?.razones, ["talk_without_lead"]);
  assertEquals(a.metadata?.talk_ids, [9001]);
  assertEquals(a.metadata?.chat_ids, ["f1a2b3c4-chat"]);
  assertEquals(a.metadata?.contact_ids, [7777]);
  assertEquals(JSON.stringify(a).includes("quiero información"), false);
});

Deno.test("droppedAlertFor: un talk_id inválido NO se guarda crudo en la alerta", () => {
  const a = droppedAlertFor({
    queueId: "q2",
    attempts: 7,
    unresolved: [{ message: { ...onlinechat, talk_id: "<script>", chat_id: "@everyone hola", contact_id: "x" }, reason: "no_talk_id" }],
  });
  assertEquals(a.metadata?.talk_ids, []);
  assertEquals(a.metadata?.chat_ids, []);
  assertEquals(a.metadata?.contact_ids, []);
  assertEquals(JSON.stringify(a).includes("<script>"), false);
  assertEquals(JSON.stringify(a).includes("@everyone"), false);
});

Deno.test("el reaper de claim_inbound_batch (0092) usa el MISMO tope que LEAD_RESOLVE_MAX_ATTEMPTS", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/0092_inbound_queue_not_before.sql", import.meta.url));
  const m = sql.match(/v_lead_max_attempts\s+constant\s+int\s*:=\s*(\d+)/);
  assertEquals(m ? Number(m[1]) : null, LEAD_RESOLVE_MAX_ATTEMPTS);
  // Y al rendirse por worker muerto deja la MISMA alerta (nunca un failed silencioso).
  assertEquals(/insert into public\.alerts[\s\S]*'inbound_lead_unresolved'/.test(sql), true);
});

Deno.test("seguridad: _orig_idx hostil no mueve created_at ni reordena (acotado)", () => {
  assertEquals(messageOrderIndex({ _orig_idx: 1e12 }, 0), MAX_ORDER_INDEX);
  assertEquals(messageOrderIndex({ _orig_idx: Number.MAX_SAFE_INTEGER }, 3), MAX_ORDER_INDEX);
  assertEquals(messageOrderIndex({ _orig_idx: -5 }, 2), 2);
  assertEquals(messageOrderIndex({ _orig_idx: "9999999" }, 2), 2);
  assertEquals(messageOrderIndex({ _orig_idx: 1.5 }, 2), 2);
  assertEquals(messageOrderIndex({}, 2000), MAX_ORDER_INDEX);
  assertEquals(messageOrderIndex({ _orig_idx: 4 }, 0), 4);
});

Deno.test("seguridad: stripOrderMarkers borra _orig_idx de lo que llega por el webhook", () => {
  const hostile = {
    account: { subdomain: "x" },
    message: { add: [{ ...onlinechat, _orig_idx: 999999999 }, { id: "2", _orig_idx: 5, text: "hola" }] },
    leads: { add: [{ id: "1" }] },
    _orig_idx: 3,
  };
  const out = stripOrderMarkers(hostile) as typeof hostile;
  assertEquals(JSON.stringify(out).includes("_orig_idx"), false);
  assertEquals(out.message.add[0].id, onlinechat.id);
  assertEquals(out.message.add[1].text, "hola");
  // Sin message.add o con formas raras no revienta.
  assertEquals(stripOrderMarkers({ _raw: "x" }), { _raw: "x" });
  assertEquals(stripOrderMarkers({ message: { add: "no-array" } }), { message: { add: "no-array" } });
});

Deno.test("seguridad: contact_id solo se confía si lo confirma la API de talks", async () => {
  const talk = { id: 9001, entity_id: null, entity_type: "lead", contact_id: 4242 };
  const r = await resolveLeadId({ ...onlinechat, contact_id: "7777" }, async () => talk);
  assertEquals(r.kind, "unresolved");
  if (r.kind === "unresolved") {
    assertEquals(r.reason, "talk_without_lead");
    // El del talk (4242), nunca el del payload (7777).
    assertEquals(r.verifiedContactId, 4242);
  }
  const r2 = await resolveLeadId(onlinechat, async () => ({ ...talk, contact_id: "abc" }));
  if (r2.kind === "unresolved") assertEquals(r2.verifiedContactId, undefined);
  const r3 = await resolveLeadId(onlinechat, async () => { throw new Error("x"); });
  if (r3.kind === "unresolved") assertEquals(r3.verifiedContactId, undefined);
});

Deno.test("seguridad: el diferimiento tiene un tope duro medido desde el mensaje sin responder MÁS VIEJO", () => {
  const now = 1_000_000_000_000;
  const old = now - (LEAD_WAIT_DEFER_SECONDS + 1) * 1000;
  // Mensaje viejo: no se difiere aunque haya filas nuevas esperando (no extienden el tope).
  assertEquals(shouldDeferForWaitingRow({ nowMs: now, oldestUnansweredMs: old, hasWaitingRow: true }), false);
  // Reciente + fila esperando: se difiere.
  assertEquals(shouldDeferForWaitingRow({ nowMs: now, oldestUnansweredMs: now - 5_000, hasWaitingRow: true }), true);
  assertEquals(shouldDeferForWaitingRow({ nowMs: now, oldestUnansweredMs: now - 5_000, hasWaitingRow: false }), false);
  // Fecha ilegible/futura: no se difiere indefinidamente.
  assertEquals(shouldDeferForWaitingRow({ nowMs: now, oldestUnansweredMs: NaN, hasWaitingRow: true }), false);
  assertEquals(shouldDeferForWaitingRow({ nowMs: now, oldestUnansweredMs: now + 3_600_000, hasWaitingRow: true }), false);
});

// ---- H2: amplificación desde un payload forjado (webhook público) ----

Deno.test("H2: tope de talks DISTINTOS consultados por fila; el resto se rinde sin consultar", async () => {
  const asked: number[] = [];
  const ctx = newTalkLookup(newTalkCache());
  const fetchTalk = async (id: number) => { asked.push(id); return { entity_id: null, entity_type: null }; };
  const out = [];
  for (let i = 0; i < MAX_TALK_LOOKUPS_PER_ROW + 4; i++) {
    out.push(await resolveLeadId({ ...onlinechat, id: `m${i}`, talk_id: String(1000 + i) }, fetchTalk, ctx));
  }
  assertEquals(asked.length, MAX_TALK_LOOKUPS_PER_ROW);
  const capped = out.filter((r) => r.kind === "unresolved" && r.reason === "talk_lookup_capped");
  assertEquals(capped.length, 4);
  // Repetir un talk ya consultado no gasta cupo (caché negativa de la corrida).
  const again = await resolveLeadId({ ...onlinechat, id: "x", talk_id: "1000" }, fetchTalk, ctx);
  assertEquals(again.kind === "unresolved" && again.reason, "talk_without_lead");
  assertEquals(asked.length, MAX_TALK_LOOKUPS_PER_ROW);
});

Deno.test("H2: caché NEGATIVA dentro de la corrida (compartida entre filas), con vida menor que la primera espera", async () => {
  assert(NEGATIVE_TALK_CACHE_MS < LEAD_RESOLVE_BACKOFF_SECONDS[0] * 1000, "un reintento legítimo nunca choca con su propio negativo");
  let now = 1_000;
  const cache = newTalkCache();
  let calls = 0;
  const fetchTalk = async () => { calls++; return { entity_id: null, entity_type: null, contact_id: 4242 }; };
  const r1 = await resolveLeadId(onlinechat, fetchTalk, newTalkLookup(cache, { now: () => now }));
  const r2 = await resolveLeadId({ ...onlinechat, id: "otro" }, fetchTalk, newTalkLookup(cache, { now: () => now }));
  assertEquals(calls, 1);
  assertEquals(r2, r1);
  now += NEGATIVE_TALK_CACHE_MS + 1;
  await resolveLeadId(onlinechat, fetchTalk, newTalkLookup(cache, { now: () => now }));
  assertEquals(calls, 2);
});

Deno.test("L4: presupuesto de tiempo por fila para las consultas de talks (una consulta colgada no mata el worker)", async () => {
  let aborted = false;
  const hang = (_id: number, signal?: AbortSignal) =>
    new Promise<unknown>((_res, rej) => signal?.addEventListener("abort", () => { aborted = true; rej(new Error("abort")); }));
  const ctx = newTalkLookup(newTalkCache(), { budgetMs: 50 });
  const t0 = performance.now();
  const r = await resolveLeadId(onlinechat, hang, ctx);
  assert(performance.now() - t0 < 1_000);
  assertEquals(r.kind === "unresolved" && r.reason, "talk_lookup_budget");
  assertEquals(aborted, true);
  // Sin presupuesto restante no se consulta nada más en esta fila (se reintenta después).
  let calls = 0;
  const r2 = await resolveLeadId({ ...onlinechat, talk_id: "9002" }, async () => { calls++; return null; }, ctx);
  assertEquals(calls, 0);
  assertEquals(r2.kind === "unresolved" && r2.reason, "talk_lookup_budget");
  assertEquals(TALK_LOOKUP_ROW_BUDGET_MS > 0, true);
});

Deno.test("talk de contacto/empresa = talk_other_entity, TRANSITORIO (Kommo puede estar creando el lead); solo el PAYLOAD lo vuelve permanente", async () => {
  const r = await resolveLeadId(onlinechat, async () => ({ entity_id: 42, entity_type: "contact" }));
  assertEquals(r.kind === "unresolved" && r.reason, "talk_other_entity");
  const { talk_id: _t, ...sinTalk } = onlinechat;
  const r2 = await resolveLeadId({ ...sinTalk, entity_id: "42", entity_type: "contact" }, async () => null);
  assertEquals(r2.kind === "unresolved" && r2.reason, "not_lead_entity");
  // El payload Y el talk dicen contacto: no es de un lead (permanente).
  const r3 = await resolveLeadId({ ...onlinechat, entity_id: "42", entity_type: "contact" }, async () => ({ entity_id: 42, entity_type: "contact" }));
  assertEquals(r3.kind === "unresolved" && r3.reason, "not_lead_entity");
  for (const reason of ["no_talk_id", "no_kommo_credentials", "not_lead_entity", "talk_lookup_capped"] as const) {
    assertEquals(isPermanentReason(reason), true, reason);
  }
  for (const reason of ["talk_not_found", "talk_without_lead", "talk_lookup_failed", "talk_lookup_budget", "talk_other_entity"] as const) {
    assertEquals(isPermanentReason(reason), false, reason);
  }
});

Deno.test("talk_other_entity: se reintenta como talk_not_found y, agotado, alerta AGREGADA (no solo log)", () => {
  const u = { message: onlinechat, reason: "talk_other_entity" as const, index: 0 };
  const first = planUnresolved({ attempts: 1, signed: true, unresolved: [u] });
  assertEquals(first.retry.length, 1);
  assertEquals(first.delaySeconds, LEAD_RESOLVE_BACKOFF_SECONDS[0]);
  const last = planUnresolved({ attempts: LEAD_RESOLVE_MAX_ATTEMPTS, signed: true, unresolved: [u] });
  assertEquals(last.retry, []);
  assertEquals(last.logOnly, []);
  assertEquals(last.perRow, []);
  assertEquals(last.aggregated.map((x) => x.reason), ["talk_other_entity"]);
  const a = aggregatedLossAlertFor({ queueId: "q1", attempts: LEAD_RESOLVE_MAX_ATTEMPTS, signed: true, unresolved: last.aggregated });
  assertEquals(a.kind, "inbound_dropped");
  assertEquals(a.metadata?.motivo, "lead_unresolved_entidad_no_lead");
});

Deno.test("planUnresolved: lo que no puede cambiar entre intentos se rinde YA; lo transitorio espera", () => {
  const msg = (reason: UnresolvedReason, type: "incoming" | "outgoing" = "incoming") => ({
    message: { ...onlinechat, type }, reason, index: 0,
  });
  const p = planUnresolved({
    attempts: 1,
    signed: true,
    unresolved: [msg("talk_without_lead"), msg("no_talk_id"), msg("not_lead_entity"), msg("no_kommo_credentials"), msg("talk_lookup_capped", "outgoing")],
  });
  assertEquals(p.retry.map((u) => u.reason), ["talk_without_lead"]);
  assertEquals(p.delaySeconds, LEAD_RESOLVE_BACKOFF_SECONDS[0]);
  assertEquals(p.givenUp.map((u) => u.reason), ["no_talk_id", "not_lead_entity", "no_kommo_credentials", "talk_lookup_capped"]);
  // Firmado: solo un cliente de una conversación de lead que no se pudo ubicar es alerta por fila.
  assertEquals(p.perRow.map((u) => u.reason), ["no_kommo_credentials"]);
  // no_talk_id: forma desconocida → agregada. not_lead_entity: no es de un lead → solo log. Saliente: nada.
  assertEquals(p.aggregated.map((u) => u.reason), ["no_talk_id"]);
  assertEquals(p.logOnly.map((u) => u.reason), ["not_lead_entity"]);

  const exhausted = planUnresolved({ attempts: LEAD_RESOLVE_MAX_ATTEMPTS, signed: true, unresolved: [msg("talk_without_lead")] });
  assertEquals(exhausted.retry, []);
  assertEquals(exhausted.perRow.map((u) => u.reason), ["talk_without_lead"]);
});

Deno.test("H2: una fila que llegó SIN FIRMA nunca deja una alerta crítica por fila (va agregada)", () => {
  const p = planUnresolved({
    attempts: LEAD_RESOLVE_MAX_ATTEMPTS,
    signed: false,
    unresolved: [{ message: onlinechat, reason: "talk_without_lead", index: 0 }, { message: onlinechat, reason: "no_kommo_credentials", index: 1 }],
  });
  assertEquals(p.perRow, []);
  assertEquals(p.aggregated.length, 2);
  const a = aggregatedLossAlertFor({ queueId: "q9", attempts: 7, signed: false, unresolved: p.aggregated });
  assertEquals(a.kind, "inbound_dropped");
  assertEquals(a.ref_id, undefined);
  assertEquals(a.metadata?.motivo, "lead_unresolved_sin_firma");
  assertEquals(JSON.stringify(a).includes("quiero información"), false);
  const b = aggregatedLossAlertFor({ queueId: "q9", attempts: 1, signed: true, unresolved: [{ message: onlinechat, reason: "no_talk_id" }] });
  assertEquals(b.metadata?.motivo, "lead_unresolved_forma_desconocida");
});

Deno.test("fila SIN FIRMA: a lo sumo 1 talk consultado y sin reintentos (se rinde ya, alerta agregada)", async () => {
  const asked: number[] = [];
  const ctx = newTalkLookup(newTalkCache(), { signed: false });
  const fetchTalk = async (id: number) => { asked.push(id); return { entity_id: null, entity_type: null }; };
  const r1 = await resolveLeadId({ ...onlinechat, talk_id: "1" }, fetchTalk, ctx);
  const r2 = await resolveLeadId({ ...onlinechat, talk_id: "2" }, fetchTalk, ctx);
  assertEquals(asked, [1]);
  assertEquals(r1.kind === "unresolved" && r1.reason, "talk_without_lead");
  assertEquals(r2.kind === "unresolved" && r2.reason, "talk_lookup_capped");
  // Firmada: el cupo normal.
  assertEquals(newTalkLookup(newTalkCache(), { signed: true }).maxDistinct, MAX_TALK_LOOKUPS_PER_ROW);
  const p = planUnresolved({
    attempts: 1,
    signed: false,
    unresolved: [
      { message: onlinechat, reason: "talk_without_lead", index: 0 },
      { message: onlinechat, reason: "talk_not_found", index: 1 },
    ],
  });
  assertEquals(p.retry, []);
  assertEquals(p.delaySeconds, undefined);
  assertEquals(p.givenUp.length, 2);
  assertEquals(p.aggregated.length, 2);
  assertEquals(p.perRow, []);
});

Deno.test("plazo de la CORRIDA para consultas de talks, compartido entre filas (un lote no excede el wall clock)", async () => {
  let now = 10_000;
  const runDeadlineMs = now + 1_000;
  let calls = 0;
  const fetchTalk = async () => { calls++; now += 600; return { entity_id: null, entity_type: null }; };
  const cache = newTalkCache();
  // Cada fila tiene su presupuesto propio (20 s), pero el de la corrida manda.
  const row1 = newTalkLookup(cache, { now: () => now, runDeadlineMs });
  assertEquals(row1.deadlineMs, runDeadlineMs);
  await resolveLeadId({ ...onlinechat, talk_id: "11" }, fetchTalk, row1);
  const row2 = newTalkLookup(cache, { now: () => now, runDeadlineMs });
  await resolveLeadId({ ...onlinechat, talk_id: "12" }, fetchTalk, row2);
  const row3 = newTalkLookup(cache, { now: () => now, runDeadlineMs });
  const r3 = await resolveLeadId({ ...onlinechat, talk_id: "13" }, fetchTalk, row3);
  assertEquals(calls, 2);
  assertEquals(r3.kind === "unresolved" && r3.reason, "talk_lookup_budget");
  assert(TALK_LOOKUP_RUN_BUDGET_MS >= TALK_LOOKUP_ROW_BUDGET_MS);
  assert(TALK_LOOKUP_RUN_BUDGET_MS <= 60_000, "acotado muy por debajo del wall clock del worker");
});

Deno.test("despertar: SOLO filas que siguen esperando el lead (sin fallas de procesamiento), nunca un reintento por excepción", () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const q = {
    eq(c: string, v: unknown) { calls.push(["eq", c, v]); return q; },
    overlaps(c: string, v: unknown) { calls.push(["overlaps", c, v]); return q; },
    gt(c: string, v: unknown) { calls.push(["gt", c, v]); return q; },
    like(c: string, v: unknown) { calls.push(["like", c, v]); return q; },
  };
  const out = applyWakeFilter(q, ["talk:1"], "2026-10-19T12:00:00.000Z");
  assertEquals(out, q);
  assertEquals(calls, [
    ["eq", "status", "pending"],
    ["eq", "processing_failures", 0],
    ["like", "last_error", `${WAKE_LAST_ERROR_PREFIX}%`],
    ["overlaps", "waiting_refs", ["talk:1"]],
    ["gt", "not_before", "2026-10-19T12:00:00.000Z"],
  ]);
  assertEquals(WAKE_LAST_ERROR_PREFIX, "lead_unresolved");
});

Deno.test("despertar: una fila SIN firma no junta refs (no puede despertar filas de otras conversaciones)", () => {
  const m = { talk_id: "77", chat_id: "abc-1" };
  assertEquals(wakeRefsForTrusted(m, { signed: false, via: "payload" }), []);
  assertEquals(wakeRefsForTrusted(m, { signed: false, via: "talk" }), []);
});

Deno.test("despertar: una fila firmada junta refs si el lead vino del payload firmado o lo confirmó la API de talks", () => {
  const m = { talk_id: "77", chat_id: "abc-1" };
  assertEquals(wakeRefsForTrusted(m, { signed: true, via: "payload" }), ["talk:77", "chat:abc-1"]);
  assertEquals(wakeRefsForTrusted(m, { signed: true, via: "talk" }), ["talk:77", "chat:abc-1"]);
});

Deno.test("despertar: tope de despertares por fila, paridad con la migración 0094", async () => {
  assertEquals(MAX_WAKES_PER_ROW, 3);
  const sql = await Deno.readTextFile(new URL("../../migrations/0094_wake_waiting_rows.sql", import.meta.url));
  assert(sql.includes(`v_max_wakes constant int := ${MAX_WAKES_PER_ROW};`), "el tope de la migración no coincide");
});
