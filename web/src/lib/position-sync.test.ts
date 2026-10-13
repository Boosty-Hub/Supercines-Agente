// Tests de requestPositionSync (puro). Correr con: cd web && node --test src/lib/position-sync.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestPositionSync } from "./position-sync.ts";

function fakeFetch(outcome: string | Error | { ok: false }) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === "object" && "ok" in outcome) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ ok: true, outcome }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("applied -> true", async () => {
  const f = fakeFetch("applied");
  assert.equal(await requestPositionSync("a", f.impl), true);
  assert.deepEqual(f.calls, ["/api/leads/a/position"]);
});

test("otros outcomes, HTTP no-ok y errores de red -> false (fail-open)", async () => {
  assert.equal(await requestPositionSync("b", fakeFetch("stale").impl), false);
  assert.equal(await requestPositionSync("c", fakeFetch({ ok: false }).impl), false);
  assert.equal(await requestPositionSync("d", fakeFetch(new Error("red")).impl), false);
});

test("StrictMode: dos pedidas concurrentes del mismo lead comparten UNA request y AMBAS ven el applied", async () => {
  const f = fakeFetch("applied");
  const primera = requestPositionSync("e", f.impl); // 1er montaje (luego desmontado por StrictMode)
  const segunda = requestPositionSync("e", f.impl); // 2do montaje
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await Promise.all([primera, segunda]), [true, true]);
});

test("lo que se recuerda es la request en vuelo: al llegar la respuesta un montaje posterior vuelve a consultar", async () => {
  const f = fakeFetch("applied");
  await requestPositionSync("f", f.impl);
  await requestPositionSync("f", f.impl);
  assert.equal(f.calls.length, 2);
});

test("leads distintos no se mezclan", async () => {
  const f = fakeFetch("applied");
  await Promise.all([requestPositionSync("g", f.impl), requestPositionSync("h", f.impl)]);
  assert.equal(f.calls.length, 2);
});
