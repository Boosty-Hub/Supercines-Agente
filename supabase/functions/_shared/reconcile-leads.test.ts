// _shared/reconcile-leads.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/reconcile-leads.test.ts
import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { reconcileLeadIds, type ReconcileDeps } from "./reconcile-leads.ts";
import type { KommoLeadPosition } from "./kommo.ts";

function lead(id: number): KommoLeadPosition {
  return { id, status_id: 10, pipeline_id: 1 };
}

/** `alive`: ids que Kommo conoce. Registra lotes pedidos, lo aplicado y lo marcado. */
function fake(alive: number[], opts: { failOnBatch?: number } = {}) {
  const batches: number[][] = [];
  const applied: number[] = [];
  const marked: number[][] = [];
  const slept: number[] = [];
  const deps: ReconcileDeps = {
    fetchByIds: (ids) => {
      batches.push(ids);
      if (opts.failOnBatch === batches.length) return Promise.reject(new Error("429 sostenido"));
      return Promise.resolve({
        leads: ids.filter((i) => alive.includes(i)).map(lead),
        hasMore: false,
        readAtMs: 1234,
      });
    },
    apply: (leads, readAt) => {
      assertEquals(readAt, 1234);
      applied.push(...leads.map((l) => l.id));
      return Promise.resolve(leads.length);
    },
    markMissing: (ids) => {
      marked.push(ids);
      return Promise.resolve(ids.length);
    },
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
  return { deps, batches, applied, marked, slept };
}

const OPTS = { batchSize: 100, pauseMs: 250 };

Deno.test("un lead vivo que la paginación saltó se APLICA y no se marca; solo el ausente se marca", async () => {
  const f = fake([2]); // Kommo conoce el 2; el 3 se borró
  const r = await reconcileLeadIds([2, 3], f.deps, OPTS);
  assertEquals(r, { checked: 2, found: 1, marked: 1, suspicious: false });
  assertEquals(f.applied, [2]);
  assertEquals(f.marked, [[3]]);
});

Deno.test("pide los ids en lotes de batchSize, con pausa entre lotes (no después del último)", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => i + 1);
  const f = fake(ids); // todos vivos
  const r = await reconcileLeadIds(ids, f.deps, OPTS);
  assertEquals(f.batches.map((b) => b.length), [100, 100, 50]);
  assertEquals(f.slept, [250, 250]);
  assertEquals(r.marked, 0);
  assertEquals(r.found, 250);
});

Deno.test("sin ids no llama a Kommo", async () => {
  const f = fake([]);
  assertEquals(await reconcileLeadIds([], f.deps, OPTS), { checked: 0, found: 0, marked: 0, suspicious: false });
  assertEquals(f.batches.length, 0);
});

Deno.test("si un LOTE grande vuelve vacio, es sospechoso aunque otro lote haya vuelto bien: solo ese lote no se marca", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => i + 1);
  // vivos: 1..100 (lote 1 ok); el lote 2 (101..150, 50 ids) vuelve vacío
  const f = fake(Array.from({ length: 100 }, (_, i) => i + 1));
  const r = await reconcileLeadIds(ids, f.deps, OPTS);
  assertEquals(r.suspicious, true);
  assertEquals(r.marked, 0);
  assertEquals(f.marked.length, 0);
});

Deno.test("un lote chico vacio no es sospechoso, pero se confirma con una SEGUNDA lectura antes de marcar", async () => {
  const f = fake([]);
  const r = await reconcileLeadIds([7, 8], f.deps, OPTS);
  assertEquals(f.batches, [[7, 8], [7, 8]]); // lectura + confirmación
  assertEquals(r, { checked: 2, found: 0, marked: 2, suspicious: false });
});

Deno.test("una respuesta vacia PUNTUAL (la segunda lectura sí lo devuelve) no marca y aplica el lead", async () => {
  const batches: number[][] = [];
  const applied: number[] = [];
  const marked: number[][] = [];
  const deps: ReconcileDeps = {
    fetchByIds: (ids) => {
      batches.push(ids);
      // primera lectura vacía (glitch); segunda devuelve el lead 7
      return Promise.resolve({ leads: batches.length === 1 ? [] : [lead(7)], hasMore: false, readAtMs: 1 });
    },
    apply: (ls) => { applied.push(...ls.map((l) => l.id)); return Promise.resolve(ls.length); },
    markMissing: (ids) => { marked.push(ids); return Promise.resolve(ids.length); },
    sleep: () => Promise.resolve(),
  };
  const r = await reconcileLeadIds([7], deps, OPTS);
  assertEquals(applied, [7]);
  assertEquals(marked.length, 0);
  assertEquals(r.found, 1);
  assertEquals(r.marked, 0);
});

Deno.test("si Kommo no devuelve NINGUNO de muchos ids, es sospechoso: no marca nada", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => i + 1);
  const f = fake([]);
  const r = await reconcileLeadIds(ids, f.deps, OPTS);
  assertEquals(r, { checked: 30, found: 0, marked: 0, suspicious: true });
  assertEquals(f.marked.length, 0);
});

Deno.test("con pocos ids, que ninguno vuelva sí es plausible (se borraron) y se marcan", async () => {
  const f = fake([]);
  const r = await reconcileLeadIds([7, 8], f.deps, OPTS);
  assertEquals(r, { checked: 2, found: 0, marked: 2, suspicious: false });
});

Deno.test("un error de Kommo a mitad NO marca nada (ni siquiera lo ya revisado como ausente)", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => i + 1);
  const f = fake([1], { failOnBatch: 2 });
  await assertRejects(() => reconcileLeadIds(ids, f.deps, OPTS), Error, "429");
  assertEquals(f.marked.length, 0);
});

Deno.test("heartbeat: se llama tras CADA lote (lectura y confirmación) para renovar el lease", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => i + 1);
  const f = fake(ids.filter((i) => i % 25 !== 0)); // 10 ausentes repartidos → segunda lectura
  let beats = 0;
  const r = await reconcileLeadIds(ids, { ...f.deps, heartbeat: () => { beats++; return Promise.resolve(); } }, OPTS);
  // 3 lotes de la primera lectura + 1 de la confirmación
  assertEquals(beats, 4);
  assertEquals(r.marked, 10);
});
