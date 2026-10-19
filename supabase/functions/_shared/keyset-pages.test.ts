// _shared/keyset-pages.test.ts
import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { collectKeyset, keysetFilter, type KeysetCursor } from "./keyset-pages.ts";

type Row = { id: string; created_at: string; n: number };

/** Tabla falsa ordenada por (created_at, id) con el corte de max_rows de PostgREST. */
function fakeTable(rows: Row[], maxRows = 1000) {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const calls: Array<{ cursor: KeysetCursor | null; limit: number }> = [];
  const fetchPage = (cursor: KeysetCursor | null, limit: number) => {
    calls.push({ cursor, limit });
    const after = cursor
      ? sorted.filter((r) => r.created_at > cursor.createdAt || (r.created_at === cursor.createdAt && r.id > String(cursor.id)))
      : sorted;
    return Promise.resolve({ data: after.slice(0, Math.min(limit, maxRows)), error: null });
  };
  return { fetchPage, calls, sorted };
}

const ts = (i: number) => new Date(Date.UTC(2026, 9, 1) + Math.floor(i / 3) * 1000).toISOString(); // 3 filas por instante: empates
const mk = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, "0")}`, created_at: ts(i), n: i }));

Deno.test("lee más de 1000 filas (antes PostgREST cortaba en 1000 sin avisar), sin repetir ni saltear con empates", async () => {
  const t = fakeTable(mk(2503));
  const r = await collectKeyset(t.fetchPage, { maxRows: 10000, label: "x" });
  assertEquals(r.rows.length, 2503);
  assertEquals(r.truncated, false);
  assertEquals(r.rows.map((x) => x.n), t.sorted.map((x) => x.n));
  assertEquals(t.calls.length, 3);
});

Deno.test("exactamente un múltiplo de la página: pide una página vacía y termina", async () => {
  const t = fakeTable(mk(2000));
  const r = await collectKeyset(t.fetchPage, { maxRows: 10000, label: "x" });
  assertEquals(r.rows.length, 2000);
  assertEquals(t.calls.length, 3);
  assertEquals(r.truncated, false);
});

Deno.test("tope maxRows: corta y avisa truncated; justo en el tope sin más filas no es truncated", async () => {
  const r = await collectKeyset(fakeTable(mk(2500)).fetchPage, { maxRows: 1500, label: "x" });
  assertEquals(r.rows.length, 1500);
  assertEquals(r.truncated, true);
  const exact = await collectKeyset(fakeTable(mk(1500)).fetchPage, { maxRows: 1500, label: "x" });
  assertEquals(exact.rows.length, 1500);
  assertEquals(exact.truncated, false);
});

Deno.test("una fila insertada a mitad de la lectura no corre las páginas (keyset, no OFFSET)", async () => {
  const base = mk(1500);
  const table = [...base];
  let call = 0;
  const fetchPage = (cursor: KeysetCursor | null, limit: number) => {
    call++;
    if (call === 2) table.push({ id: "id-000000a", created_at: ts(0), n: -1 }); // entra «al principio»
    const sorted = [...table].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const after = cursor
      ? sorted.filter((r) => r.created_at > cursor.createdAt || (r.created_at === cursor.createdAt && r.id > String(cursor.id)))
      : sorted;
    return Promise.resolve({ data: after.slice(0, limit), error: null });
  };
  const r = await collectKeyset(fetchPage, { maxRows: 10000, label: "x" });
  const ns = r.rows.map((x) => x.n);
  assertEquals(new Set(ns).size, ns.length, "sin repetidos");
  assertEquals(ns.filter((n) => n >= 0).length, 1500, "sin salteados");
});

Deno.test("un error en cualquier página lanza (no se decide con datos a medias)", async () => {
  let call = 0;
  const fetchPage = (_c: KeysetCursor | null, limit: number) =>
    Promise.resolve(++call === 2 ? { data: null, error: { message: "timeout" } } : { data: mk(limit), error: null });
  await assertRejects(() => collectKeyset(fetchPage, { maxRows: 5000, label: "outcomes" }), Error, "outcomes: timeout");
});

Deno.test("la página nunca pide más de 1000 (max_rows de Supabase)", async () => {
  const t = fakeTable(mk(10));
  await collectKeyset(t.fetchPage, { maxRows: 5000, pageSize: 5000, label: "x" });
  assertEquals(t.calls[0].limit, 1000);
});

Deno.test("keysetFilter: valores entre comillas (los timestamps traen : + .)", () => {
  assertEquals(
    keysetFilter({ createdAt: "2026-10-19T15:18:58.876537+00:00", id: "ab-1" }),
    'created_at.gt."2026-10-19T15:18:58.876537+00:00",and(created_at.eq."2026-10-19T15:18:58.876537+00:00",id.gt."ab-1")',
  );
});

Deno.test("keysetFilter desc: lt en las dos columnas", () => {
  assertEquals(keysetFilter({ createdAt: "2026-10-19T00:00:00+00:00", id: 7 }, "desc"),
    'created_at.lt."2026-10-19T00:00:00+00:00",and(created_at.eq."2026-10-19T00:00:00+00:00",id.lt."7")');
});
