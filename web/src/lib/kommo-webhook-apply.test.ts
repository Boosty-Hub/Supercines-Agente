// Tests de applyWebhookDestination (único camino que registra/da de baja el webhook en Kommo;
// lo comparten /api/kommo/webhook-auth y /api/kommo/reconnect-webhook). fetch se sustituye.
// Correr con: cd web && node --test src/lib/kommo-webhook-apply.test.ts
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { applyWebhookDestination } from "./kommo-webhook-apply.ts";
import { webhookDestination } from "./kommo-webhook.ts";

const BASE = "https://abc.supabase.co";
const VIEJO = `${BASE}/functions/v1/kommo-webhook`;
const NUEVO = webhookDestination(BASE, "SECRETO-NUEVO");
const conn = { dominio: "x.kommo.com", token: "t" };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Hook = { destination: string; settings?: string[]; disabled?: boolean };

/** Kommo falso: guarda los hooks y registra el orden de las llamadas. */
function fakeKommo(initial: Hook[], opts: { postStatus?: number; postBody?: string; keepDisabled?: boolean } = {}) {
  let hooks = [...initial];
  const calls: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push(method === "GET" ? "GET" : `${method} ${body.destination}`);
    if (method === "GET") return new Response(JSON.stringify({ _embedded: { webhooks: hooks } }), { status: 200 });
    if (method === "POST") {
      if (opts.postStatus) return new Response(opts.postBody ?? "", { status: opts.postStatus });
      hooks = hooks.filter((h) => h.destination !== body.destination);
      hooks.push({ destination: body.destination, settings: body.settings, disabled: opts.keepDisabled === true });
      return new Response("{}", { status: 200 });
    }
    hooks = hooks.filter((h) => h.destination !== body.destination);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, hooks: () => hooks };
}

test("registra el nuevo ANTES de dar de baja el viejo, conservando los eventos del operador", async () => {
  const k = fakeKommo([
    { destination: VIEJO, settings: ["add_lead", "status_lead"] },
    { destination: "https://otra.app/hook", settings: ["add_lead"] },
  ]);
  const r = await applyWebhookDestination(conn, NUEVO);
  assert.deepEqual(r, { ok: true, removed: 1, settings: ["add_lead", "status_lead"], failedDeletes: 0 });
  assert.deepEqual(k.calls, ["GET", `POST ${NUEVO}`, "GET", `DELETE ${VIEJO}`]);
  assert.deepEqual(k.hooks().map((h) => h.destination).sort(), ["https://otra.app/hook", NUEVO].sort());
});

test("reconectar un webhook deshabilitado lo rehabilita (POST idempotente) sin borrar nada", async () => {
  const k = fakeKommo([{ destination: NUEVO, settings: ["add_message"], disabled: true }]);
  const r = await applyWebhookDestination(conn, NUEVO);
  assert.equal(r.ok, true);
  assert.deepEqual(k.calls, ["GET", `POST ${NUEVO}`, "GET"]);
});

test("si Kommo no lo deja habilitado, NO se da de baja el viejo y es error", async () => {
  const k = fakeKommo([{ destination: VIEJO }], { keepDisabled: true });
  const r = await applyWebhookDestination(conn, NUEVO);
  assert.equal(r.ok, false);
  assert.equal(k.calls.some((c) => c.startsWith("DELETE")), false);
});

test("el error de Kommo NO devuelve el secreto aunque Kommo lo repita", async () => {
  fakeKommo([], { postStatus: 400, postBody: `{"detail":"destination ${NUEVO} invalid"}` });
  const r = await applyWebhookDestination(conn, NUEVO);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !r.error.includes("SECRETO-NUEVO"), !r.ok ? r.error : "");
  assert.ok(!r.ok && r.error.startsWith("Kommo respondió 400"));
});

test("sin conexión configurada no llama a Kommo", async () => {
  const k = fakeKommo([]);
  const r = await applyWebhookDestination({ dominio: "", token: "t" }, NUEVO);
  assert.deepEqual(r, { ok: false, error: "Falta configurar la conexión con Kommo" });
  assert.deepEqual(k.calls, []);
});
