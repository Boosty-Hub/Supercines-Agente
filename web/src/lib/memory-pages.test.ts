// Correr con: cd web && node --test src/lib/memory-pages.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectMemoryPages, parseMemoryPage, type MemoryPage } from "./memory-pages.ts";

/** API falsa: `total` memorias en páginas de 100, cursor opaco `c<n>`. */
function fakeApi(total: number) {
  const asked: Array<string | null> = [];
  const fetchPage = (cursor: string | null): Promise<MemoryPage<{ id: number; type: string }>> => {
    asked.push(cursor);
    const start = cursor ? Number(cursor.slice(1)) : 0;
    const data = Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, i) => ({ id: start + i, type: "memory" }));
    const next = start + 100 < total ? `c${start + 100}` : null;
    return Promise.resolve(parseMemoryPage({ data, next_page: next }));
  };
  return { fetchPage, asked };
}

test("pasa de 100: sigue next_page con page=<cursor> hasta el final", async () => {
  const api = fakeApi(250);
  const r = await collectMemoryPages(api.fetchPage, { max: 5000, maxPages: 100 });
  assert.equal(r.items.length, 250);
  assert.equal(r.truncated, false);
  assert.deepEqual(api.asked, [null, "c100", "c200"]);
  assert.deepEqual(r.items.map((i) => i.id), Array.from({ length: 250 }, (_, i) => i));
});

test("exactamente 100: una sola página, sin pedir otra", async () => {
  const api = fakeApi(100);
  const r = await collectMemoryPages(api.fetchPage, { max: 5000, maxPages: 100 });
  assert.equal(r.items.length, 100);
  assert.deepEqual(api.asked, [null]);
});

test("al llegar a max lo avisa (truncated) en vez de cortar en silencio", async () => {
  const r = await collectMemoryPages(fakeApi(350).fetchPage, { max: 120, maxPages: 100 });
  assert.equal(r.items.length, 120);
  assert.equal(r.truncated, true);
  const exact = await collectMemoryPages(fakeApi(120).fetchPage, { max: 120, maxPages: 100 });
  assert.equal(exact.truncated, false, "si justo no queda nada, no está truncado");
});

test("tope de páginas → truncated; cursor repetido corta sin bucle", async () => {
  const r = await collectMemoryPages(fakeApi(1000).fetchPage, { max: 5000, maxPages: 3 });
  assert.equal(r.items.length, 300);
  assert.equal(r.truncated, true);
  let calls = 0;
  const loop = await collectMemoryPages(
    () => (calls++, Promise.resolve({ data: [{ id: calls }], nextPage: "mismo" })),
    { max: 5000, maxPages: 100 },
  );
  assert.equal(calls, 2);
  assert.equal(loop.items.length, 2);
});

test("keep filtra (p. ej. memory_prefix) sin contar contra max", async () => {
  const page = parseMemoryPage<{ type: string }>({ data: [{ type: "memory_prefix" }, { type: "memory" }], next_page: null });
  const r = await collectMemoryPages(() => Promise.resolve(page), { max: 1, maxPages: 5, keep: (i) => i.type === "memory" });
  assert.deepEqual(r.items, [{ type: "memory" }]);
  assert.equal(r.truncated, false);
});

test("parseMemoryPage: forma rara → página vacía sin cursor; next_page vacío = fin", () => {
  assert.deepEqual(parseMemoryPage(null), { data: [], nextPage: null });
  assert.deepEqual(parseMemoryPage({ data: "x", next_page: 3 }), { data: [], nextPage: null });
  assert.deepEqual(parseMemoryPage({ data: [], next_page: "" }), { data: [], nextPage: null });
});
