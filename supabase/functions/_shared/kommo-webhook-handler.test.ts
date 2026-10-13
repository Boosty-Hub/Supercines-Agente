// Correr con: deno test --node-modules-dir=auto --allow-read --allow-env supabase/functions/_shared/kommo-webhook-handler.test.ts
// El handler responde ANTES de tocar la base y decide con el estado real en segundo plano.
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { createKommoWebhookHandler, isActionable, MAX_BODY_BYTES, parseFormBracketed } from "./kommo-webhook-handler.ts";
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
