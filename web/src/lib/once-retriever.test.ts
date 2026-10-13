// Tests de onceRetriever. Correr con: cd web && node --test src/lib/once-retriever.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { onceRetriever } from "./once-retriever.ts";

function counting() {
  const calls: string[] = [];
  const retrieve = async (_k: string, id: string) => {
    calls.push(id);
    return { id, version: 1 } as never;
  };
  return { calls, retrieve };
}

test("dos lecturas concurrentes del mismo agente hacen UN solo GET", async () => {
  const c = counting();
  const once = onceRetriever(c.retrieve);
  const [a, b] = await Promise.all([once("k", "ag1"), once("k", "ag1")]);
  assert.equal(c.calls.length, 1);
  assert.equal(a, b);
});

test("agentes o keys distintos no se mezclan", async () => {
  const c = counting();
  const once = onceRetriever(c.retrieve);
  await once("k", "ag1");
  await once("k", "ag2");
  await once("otra", "ag1");
  assert.deepEqual(c.calls, ["ag1", "ag2", "ag1"]);
});

test("un retriever nuevo (otro render) vuelve a leer: no hay cache global", async () => {
  const c = counting();
  await onceRetriever(c.retrieve)("k", "ag1");
  await onceRetriever(c.retrieve)("k", "ag1");
  assert.equal(c.calls.length, 2);
});

test("si la lectura falla, ambos consumidores ven el mismo fallo (cada uno lo trata)", async () => {
  let n = 0;
  const once = onceRetriever(async () => {
    n++;
    throw new Error("anthropic caído");
  });
  const r = await Promise.allSettled([once("k", "a"), once("k", "a")]);
  assert.equal(n, 1);
  assert.deepEqual(r.map((x) => x.status), ["rejected", "rejected"]);
});
