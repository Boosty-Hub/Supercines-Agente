// Tests del disparo de Edge Functions: espera, timeout, fallo que no propaga.
// Correr con: cd web && node --test src/lib/internal-trigger.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTrigger } from "./internal-trigger.ts";

const ctx = { slug: "publish-to-kommo", context: "draft 1" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("ESPERA el acuse: no resuelve hasta que la llamada termina", async () => {
  let done = false;
  const out = await runTrigger(
    async () => {
      await sleep(30);
      done = true;
      return { ok: true, status: 202 };
    },
    ctx,
    { warn: () => {} }
  );
  assert.equal(done, true, "la llamada terminó antes de resolver el trigger");
  assert.deepEqual(out, { ok: true });
});

test("TIMEOUT: una función colgada no cuelga la respuesta y se registra con contexto", async () => {
  const warns: string[] = [];
  const t0 = Date.now();
  const out = await runTrigger(() => new Promise(() => {}), ctx, { timeoutMs: 40, warn: (m) => warns.push(m) });
  assert.ok(Date.now() - t0 < 500);
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "timeout");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /publish-to-kommo/);
  assert.match(warns[0], /draft 1/);
});

test("TimeoutError del fetch (AbortSignal.timeout) se clasifica como timeout", async () => {
  const out = await runTrigger(
    async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    },
    ctx,
    { warn: () => {} }
  );
  assert.equal(out.ok === false && out.reason, "timeout");
});

test("FALLO de red no propaga: devuelve el resultado y avisa", async () => {
  const warns: string[] = [];
  const out = await runTrigger(
    async () => {
      throw new Error("ECONNRESET");
    },
    ctx,
    { warn: (m) => warns.push(m) }
  );
  assert.deepEqual(out, { ok: false, reason: "error", detail: "ECONNRESET" });
  assert.match(warns[0], /ECONNRESET/);
});

test("HTTP no-2xx no propaga: se registra el status", async () => {
  const warns: string[] = [];
  const out = await runTrigger(async () => ({ ok: false, status: 401 }), ctx, { warn: (m) => warns.push(m) });
  assert.deepEqual(out, { ok: false, reason: "http", detail: "HTTP 401" });
  assert.match(warns[0], /HTTP 401/);
});

test("el éxito no emite warnings y libera el body", async () => {
  const warns: string[] = [];
  let cancelled = false;
  const out = await runTrigger(
    async () => ({
      ok: true,
      status: 202,
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
    }),
    ctx,
    { warn: (m) => warns.push(m) }
  );
  assert.equal(out.ok, true);
  assert.equal(cancelled, true);
  assert.equal(warns.length, 0);
});
