// Correr con: deno test --node-modules-dir=auto --allow-read --allow-env supabase/functions/_shared/kommo-webhook-handler.test.ts
// El handler responde ANTES de tocar la base y decide con el estado real en segundo plano.
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { createKommoWebhookHandler, isActionable, SIGNED_COLUMN_RETRY_MS, MAX_BODY_BYTES, parseFormBracketed } from "./kommo-webhook-handler.ts";
import { BAD_TOKEN_RECHECK_MS, resetWebhookAuthCache, resetWebhookNoteThrottle } from "./webhook-auth.ts";
import { fakeClient, harness, tablesWith } from "./webhook-test-fakes.ts";

const S = "s3cret-abc";
const URL_BASE = "https://x.supabase.co/functions/v1/kommo-webhook";
const post = (token: string | null, body = "message[add][0][text]=hola") =>
  new Request(token ? `${URL_BASE}?token=${token}` : URL_BASE, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

function setup(mode: Parameters<typeof fakeClient>[0], auth: Record<string, unknown> = {}) {
  resetWebhookAuthCache();
  resetWebhookNoteThrottle();
  const c = fakeClient(mode);
  const bg: Promise<unknown>[] = [];
  let triggers = 0;
  const handle = createKommoWebhookHandler(c.sb, {
    background: (p) => void bg.push(p),
    trigger: () => triggers++,
    retryDelayMs: 1,
    auth: { background: (p: Promise<unknown>) => void bg.push(p), ...auth },
  });
  return { c, handle, drain: () => Promise.allSettled(bg), triggers: () => triggers };
}

Deno.test("base COLGADA: responde 200 en < 1 s y no persiste nada mientras no se resuelva el estado", async () => {
  // Reloj virtual para el plazo/reintentos; el techo duro de cada consulta corre en tiempo real.
  const h = harness();
  const { c, handle, drain } = setup({ kind: "hang" }, { ...h.opts, fetchTimeoutMs: 100, deadlineMs: 4_000 });
  const t0 = performance.now();
  const res = await handle(post(S));
  const ms = performance.now() - t0;
  assertEquals(res.status, 200);
  assert(ms < 1_000, `tardó ${ms} ms`);
  assertEquals(c.inserts("inbound_queue").length, 0);
  await drain();
  await h.drain();
  // El estado nunca se conoció: no se encola (ni con token), se reintentó y se alerta.
  assertEquals(c.inserts("inbound_queue").length, 0);
  assert(c.queries() >= 2, `reintentos: ${c.queries()}`);
  assertEquals(c.inserts("alerts").map((a) => a.kind), ["inbound_dropped"]);
  assertEquals(c.inserts("alerts")[0].metadata, { motivo: "auth_state_unavailable" });
});

Deno.test("estricto + base LENTA: nunca se persiste un payload sin token válido; con token sí", async () => {
  const { c, handle, drain, triggers } = setup({ kind: "ok", tables: tablesWith(S, "strict"), delayMs: 300 });
  const t0 = performance.now();
  const r1 = await handle(post(null));
  const r2 = await handle(post("falso"));
  const r3 = await handle(post(S));
  assert(performance.now() - t0 < 100, "la respuesta no espera a la base");
  for (const r of [r1, r2, r3]) assertEquals(r.status, 200); // el descarte es silencioso para Kommo
  await drain();
  const q = c.inserts("inbound_queue");
  assertEquals(q.length, 1);
  assertEquals(q[0].payload, { message: { add: [{ text: "hola" }] } });
  assertEquals(triggers(), 1);
  // El descarte queda registrado (estrangulado) con el motivo, sin el token.
  const rejected = c.rpcs().filter((r) => r.args.p_rejected);
  assertEquals(rejected.length, 1);
  assert(["unsigned_strict", "bad_token"].includes(rejected[0].args.p_rejected));
  assert(!JSON.stringify(c.rpcs()).includes("falso"));
});

Deno.test("estricto + estado nunca conocido + base caída: no persiste, reintenta y alerta", async () => {
  const h = harness();
  const { c, handle, drain } = setup({ kind: "fail" }, { ...h.opts, deadlineMs: 6_000 });
  assertEquals((await handle(post(null))).status, 200);
  await drain();
  await h.drain();
  assertEquals(c.inserts("inbound_queue").length, 0);
  assert(c.queries() >= 3, `reintentos: ${c.queries()}`);
  assertEquals(c.inserts("alerts").map((a) => a.kind), ["inbound_dropped"]);
});

Deno.test("estado conocido y base que cae después: estricto sigue rigiendo con el último estado (no abre)", async () => {
  const h = harness();
  const { c, handle, drain } = setup({ kind: "ok", tables: tablesWith(S, "strict") }, h.opts);
  await handle(post(S));
  await drain();
  c.set({ kind: "fail" });
  h.advance(60_000); // caché vencido
  await handle(post(null));
  await handle(post(S));
  await drain();
  await h.drain();
  assertEquals(c.inserts("inbound_queue").length, 2); // las dos firmadas; la sin token no
});

Deno.test("rotación: el token NUEVO se acepta tras la recarga en una instancia caliente", async () => {
  const h = harness();
  const { c, handle, drain } = setup({ kind: "ok", tables: tablesWith("S0", "strict") }, h.opts);
  await handle(post("S0"));
  await drain();
  c.set({ kind: "ok", tables: tablesWith("S1", "strict", "S0", "2099-01-01T00:00:00Z") });
  h.advance(BAD_TOKEN_RECHECK_MS + 1);
  await handle(post("S1"));
  await handle(post("S0")); // el anterior sigue valiendo durante la gracia
  await drain();
  assertEquals(c.inserts("inbound_queue").length, 3);
  // Firmada con el vigente → confirma la rotación en la base.
  assert(c.rpcs().some((r) => r.args.p_current === true));
});

Deno.test("transición: sin token se acepta y se encola (y se registra como sin firma)", async () => {
  const { c, handle, drain } = setup({ kind: "ok", tables: tablesWith(S, "permissive") });
  await handle(post(null));
  await drain();
  assertEquals(c.inserts("inbound_queue").length, 1);
  assertEquals(c.rpcs()[0].args, { p_signed: false, p_current: false, p_rejected: null });
});

Deno.test("validaciones baratas: GET healthcheck, método y tamaño", async () => {
  const { c, handle } = setup({ kind: "ok", tables: tablesWith(S) });
  assertEquals((await handle(new Request(URL_BASE))).status, 200);
  assertEquals((await handle(new Request(URL_BASE, { method: "PUT" }))).status, 405);
  assertEquals((await handle(post(S, "x".repeat(MAX_BODY_BYTES + 1)))).status, 413);
  assertEquals(c.queries(), 0);
});

Deno.test("parseo de Kommo y payload accionable", () => {
  assertEquals(parseFormBracketed("leads[add][0][id]=123"), { leads: { add: [{ id: "123" }] } });
  // SuperCines: los Salesbots generan miles de leads.update con campos custom; solo se encolan
  // (el barrido de pg_cron los levanta), un cambio de etapa trae su leads.status y dispara.
  assertEquals(isActionable({ leads: { update: [{}] } }), false);
  assertEquals(isActionable({ leads: { status: [{}] } }), true);
  assertEquals(isActionable({ leads: { add: [{}] } }), true);
  assertEquals(isActionable({ message: { add: [{}] } }), true);
  assertEquals(isActionable({ account: {} }), true); // forma desconocida: fail-open
  assertEquals(isActionable({ leads: { delete: [{}] } }), false);
});

// MEDICIÓN (volumen alto de leads.update de los Salesbots de SuperCines): el trabajo de fondo por
// request no puede crecer con el tráfico. Con el estado de autenticación en caché, cada webhook
// cuesta UN insert; el estado se carga una vez por ventana (no por request), la nota de
// autenticidad sale una vez por minuto y por tipo, y ningún leads.update dispara process-inbound.
Deno.test("MEDICIÓN: 2000 leads.update seguidos = 2000 inserts, <= 2 cargas de estado, <= 1 nota y 0 triggers", async () => {
  const { c, handle, drain, triggers } = setup({ kind: "ok", tables: tablesWith(S, "strict") });
  const update = "leads[update][0][id]=1&leads[update][0][custom_fields][0][id]=9";
  const N = 2000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const r = await handle(post(S, update));
    assertEquals(r.status, 200);
  }
  const respondMs = performance.now() - t0;
  await drain();
  assertEquals(c.inserts("inbound_queue").length, N);
  // 1 carga inicial + 1 recarga tras la primera nota (el RPC puede cambiar el modo): acotado, no por request.
  assert(c.queries() <= 2, `cargas del estado: ${c.queries()} (no deben crecer con el tráfico)`);
  assert(c.rpcs().length <= 1, `notas de autenticidad: ${c.rpcs().length}`);
  assertEquals(triggers(), 0);
  assert(respondMs / N < 5, `la respuesta cuesta ${(respondMs / N).toFixed(3)} ms por request`);
});

// ---- Prototype pollution: el parser corre ANTES de autorizar y las claves son del emisor ----
import { FORM_LIMITS, newFormParseStats } from "./kommo-webhook-handler.ts";

/** Vigila que Object.prototype y Array.prototype queden intactos tras el callback. */
async function assertPrototypesIntact(fn: () => unknown | Promise<unknown>) {
  const before = [Object.getOwnPropertyNames(Object.prototype).sort(), Object.getOwnPropertyNames(Array.prototype).sort()];
  await fn();
  assertEquals(Object.getOwnPropertyNames(Object.prototype).sort(), before[0]);
  assertEquals(Object.getOwnPropertyNames(Array.prototype).sort(), before[1]);
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
  assertEquals(([] as unknown as Record<string, unknown>).polluted, undefined);
}

const ATAQUES = [
  "__proto__[polluted]=1",
  "__proto__[legacySecret]=hack&__proto__[mode]=permissive",
  "constructor[prototype][polluted]=1",
  "constructor[polluted]=1",
  "a[__proto__][polluted]=1",
  "a[b][constructor][prototype][polluted]=1",
  "prototype[polluted]=1",
  "leads[add][0][__proto__][polluted]=1",
  "[__proto__][polluted]=1",
  "__proto__=x",
];

Deno.test("parseFormBracketed: ningún payload con __proto__ / constructor / prototype contamina los prototipos", async () => {
  for (const atk of ATAQUES) {
    await assertPrototypesIntact(() => {
      const out = parseFormBracketed(`${atk}&ok=1`);
      assertEquals(out.ok, "1"); // lo legítimo sigue entrando
      assertEquals(Object.getPrototypeOf(out), null);
    });
  }
});

Deno.test("parseFormBracketed: la clave con un segmento prohibido se descarta ENTERA (no deja basura anidada)", () => {
  const out = parseFormBracketed("a[__proto__][x]=1&a[ok]=2&constructor[prototype][y]=3");
  assertEquals(JSON.stringify(out), '{"a":{"ok":"2"}}');
});

Deno.test("parseFormBracketed: el resultado y sus anidados no tienen prototipo (no heredan nada)", () => {
  const out = parseFormBracketed("leads[add][0][id]=1&a[b][c]=2") as Record<string, any>;
  assertEquals(Object.getPrototypeOf(out), null);
  assertEquals(Object.getPrototypeOf(out.a), null);
  assertEquals(Object.getPrototypeOf(out.a.b), null);
  assert(Array.isArray(out.leads.add));
  assertEquals(out.toString, undefined); // nada heredado
  assertEquals((out as Record<string, unknown>).hasOwnProperty, undefined);
});

Deno.test("parseFormBracketed: profundidad excesiva se descarta, la permitida entra", () => {
  const ok = Array.from({ length: FORM_LIMITS.maxDepth - 1 }, () => "[k]").join("");
  const tooDeep = Array.from({ length: FORM_LIMITS.maxDepth + 1 }, () => "[k]").join("");
  assertEquals(JSON.stringify(parseFormBracketed(`a${ok}=1`)).includes('"1"'), true);
  assertEquals(JSON.stringify(parseFormBracketed(`a${tooDeep}=1&z=2`)), '{"z":"2"}');
});

Deno.test("parseFormBracketed: índices enormes no arman arrays dispersos (DoS) y se descartan", () => {
  const out = parseFormBracketed(`a[999999999][x]=1&b[${FORM_LIMITS.maxIndex + 1}]=2&c[0]=ok`);
  assertEquals(JSON.stringify(out).length < 200, true);
  assertEquals(JSON.stringify(out), '{"a":[],"b":[],"c":["ok"]}');
  // un índice en el límite sí entra
  const edge = parseFormBracketed(`d[${FORM_LIMITS.maxIndex}]=x`) as Record<string, unknown[]>;
  assertEquals(edge.d.length, FORM_LIMITS.maxIndex + 1);
});

Deno.test("parseFormBracketed: un array solo admite índices numéricos (no length ni claves de texto)", () => {
  const out = parseFormBracketed("a[0]=x&a[length]=999999&a[foo]=y") as Record<string, unknown[]>;
  assertEquals(out.a.length, 1);
  assertEquals(JSON.stringify(out), '{"a":["x"]}');
});

Deno.test("parseFormBracketed: tope de claves por request", () => {
  const body = Array.from({ length: FORM_LIMITS.maxKeys + 500 }, (_, i) => `k${i}=v`).join("&");
  assertEquals(Object.keys(parseFormBracketed(body)).length, FORM_LIMITS.maxKeys);
});

Deno.test("HANDLER: un payload con __proto__[legacySecret] no contamina nada ni altera la autenticación", async () => {
  await assertPrototypesIntact(async () => {
    // estricto: sin token válido NO se persiste, aunque el payload intente inyectar un secreto/modo por herencia
    const { c, handle, drain } = setup({ kind: "ok", tables: tablesWith(S, "strict") });
    const evil = "__proto__[legacySecret]=hack&__proto__[secrets][0]=hack&__proto__[mode]=permissive&constructor[prototype][mode]=permissive&message[add][0][text]=hola";
    const r1 = await handle(post(null, evil));
    const r2 = await handle(post("hack", evil)); // intentar autenticarse con el «secreto» inyectado
    assertEquals(r1.status, 200);
    assertEquals(r2.status, 200);
    await drain();
    assertEquals(c.inserts("inbound_queue").length, 0, "nada sin token válido");
    // y con el token real sigue funcionando, con la basura descartada
    const r3 = await handle(post(S, evil));
    assertEquals(r3.status, 200);
    await drain();
    const q = c.inserts("inbound_queue");
    assertEquals(q.length, 1);
    assertEquals(JSON.stringify(q[0].payload), '{"message":{"add":[{"text":"hola"}]}}');
  });
});

Deno.test("HANDLER: con Object.prototype YA contaminado, las opciones de seguridad no se leen por herencia", async () => {
  // Simula una contaminación previa (otra librería): el handler no debe adoptar legacySecret heredado.
  (Object.prototype as Record<string, unknown>).legacySecret = "hack";
  try {
    const { c, handle, drain } = setup({ kind: "ok", tables: tablesWith(S, "strict") });
    const r = await handle(post("hack"));
    assertEquals(r.status, 200);
    await drain();
    assertEquals(c.inserts("inbound_queue").length, 0, "el secreto heredado NO autentica");
  } finally {
    delete (Object.prototype as Record<string, unknown>).legacySecret;
  }
});

Deno.test("el payload REAL más profundo de Kommo (custom_fields) entra completo con los límites actuales", () => {
  const real = "leads[update][0][custom_fields][0][values][0][value]=hola&leads[update][0][custom_fields][0][values][0][enum]=1&leads[update][0][id]=7";
  const out = JSON.stringify(parseFormBracketed(real));
  assert(out.includes('"value":"hola"') && out.includes('"enum":"1"') && out.includes('"id":"7"'), out);
  // 8 segmentos usados de 10 permitidos
  assert("leads[update][0][custom_fields][0][values][0][value]".replace(/\]/g, "").split("[").length <= FORM_LIMITS.maxDepth);
});

Deno.test("parseFormBracketed cuenta lo que descarta (profundidad, claves, prohibidas, índice) sin guardar contenido", () => {
  const st = newFormParseStats();
  const deep = Array.from({ length: FORM_LIMITS.maxDepth + 1 }, () => "[k]").join("");
  parseFormBracketed(`a${deep}=1&__proto__[x]=1&constructor[y]=1&b[99999999]=1&ok=1`, st);
  assertEquals(st.depth, 1);
  assertEquals(st.forbidden, 2);
  assertEquals(st.index, 1);
  const st2 = newFormParseStats();
  parseFormBracketed(Array.from({ length: FORM_LIMITS.maxKeys + 3 }, (_, i) => `k${i}=v`).join("&"), st2);
  assertEquals(st2.keys, 1);
});

Deno.test("seguridad: un _orig_idx que llega por el webhook se descarta antes de encolar", async () => {
  const { c, handle, drain } = setup({ kind: "ok", tables: tablesWith(S, "strict") });
  const body = JSON.stringify({ message: { add: [{ id: "m1", type: "incoming", text: "hola", _orig_idx: 999999999999 }] }, _orig_idx: 5 });
  const res = await handle(
    new Request(`${URL_BASE}?token=${S}`, { method: "POST", headers: { "content-type": "application/json" }, body }),
  );
  assertEquals(res.status, 200);
  await drain();
  const q = c.inserts("inbound_queue");
  assertEquals(q.length, 1);
  assert(!JSON.stringify(q[0].payload).includes("_orig_idx"));
  assertEquals((q[0].payload as { message: { add: Array<{ text: string }> } }).message.add[0].text, "hola");
});

Deno.test("H2: la fila encolada lleva `signed` (true con token, false sin firma) para decidir cómo se alerta una pérdida", async () => {
  const { c, handle, drain } = setup({ kind: "ok", tables: tablesWith(S, "permissive") });
  await handle(post(S));
  await handle(post(null));
  await drain();
  const q = c.inserts("inbound_queue");
  assertEquals(q.map((r) => r.signed).sort(), [false, true]);
});

Deno.test("H2: sin la columna `signed` (0092 sin aplicar) encola igual, sin el marcador (nunca pierde el payload)", async () => {
  const insertError = (t: string, row: Record<string, unknown>) =>
    t === "inbound_queue" && "signed" in row ? { code: "PGRST204", message: "Could not find the 'signed' column of 'inbound_queue'" } : null;
  const { c, handle, drain, triggers } = setup({ kind: "ok", tables: tablesWith(S, "strict"), insertError });
  await handle(post(S));
  await drain();
  const q = c.inserts("inbound_queue");
  assertEquals(q.length, 1);
  assertEquals("signed" in q[0], false);
  assertEquals(triggers(), 1);
  assertEquals(c.inserts("alerts").length, 0);
});

Deno.test("H2: tras un PGRST204 la columna `signed` se vuelve a probar a los ~5 min (instancia caliente tras aplicar 0092)", async () => {
  resetWebhookAuthCache();
  resetWebhookNoteThrottle();
  let columnExists = false;
  const insertError = (t: string, row: Record<string, unknown>) =>
    t === "inbound_queue" && "signed" in row && !columnExists
      ? { code: "PGRST204", message: "Could not find the 'signed' column of 'inbound_queue'" }
      : null;
  const c = fakeClient({ kind: "ok", tables: tablesWith(S, "strict"), insertError });
  const bg: Promise<unknown>[] = [];
  let now = 1_000_000;
  const handle = createKommoWebhookHandler(c.sb, {
    background: (p) => void bg.push(p),
    retryDelayMs: 1,
    now: () => now,
    auth: { background: (p: Promise<unknown>) => void bg.push(p) },
  });
  const drain = () => Promise.allSettled(bg);
  await handle(post(S));
  await drain();
  columnExists = true; // se aplica 0092
  now += SIGNED_COLUMN_RETRY_MS - 1;
  await handle(post(S));
  await drain();
  let q = c.inserts("inbound_queue");
  assertEquals(q.length, 2);
  assertEquals(q.map((r) => "signed" in r), [false, false]);
  now += 2;
  await handle(post(S));
  await drain();
  q = c.inserts("inbound_queue");
  assertEquals(q.length, 3);
  assertEquals(q[2].signed, true);
  assert(SIGNED_COLUMN_RETRY_MS >= 60_000 && SIGNED_COLUMN_RETRY_MS <= 10 * 60_000);
});
