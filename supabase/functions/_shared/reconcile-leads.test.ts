// _shared/reconcile-leads.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/reconcile-leads.test.ts
//
// Dos niveles:
//  - Kommo FALSO por HTTP: se reemplaza globalThis.fetch y se usa el fetchLeadsByIds real,
//    así se prueba de punta a punta qué respuesta de Kommo marca y cuál no (204, 200 con
//    lista, 429, 500, cuerpo mal formado, control ausente).
//  - Lógica pura con deps a mano (lotes, pausas, latido, tope de tiempo).
import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { reconcileLeadIds, MAX_CONTROL_FAILURES, type ReconcileDeps } from "./reconcile-leads.ts";
import { fetchLeadsByIds, KommoHttpError, KommoMalformedError, type KommoLeadPosition } from "./kommo.ts";

function lead(id: number): KommoLeadPosition {
  return { id, status_id: 10, pipeline_id: 1 };
}

// ---------------------------------------------------------------------------
// Kommo falso (HTTP)
// ---------------------------------------------------------------------------

type Reply = (ids: number[], call: number) => Response | null;

/**
 * Kommo que conoce `alive`: GET /api/v4/leads?filter[id][]=… devuelve 200 con los vivos
 * pedidos, o 204 si ninguno existe (el comportamiento real). `override` puede reemplazar la
 * respuesta de una llamada (devolver null = comportamiento normal).
 */
function withFakeKommo(alive: number[], override?: Reply) {
  const calls: number[][] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const ids = url.searchParams.getAll("filter[id][]").map(Number);
    calls.push(ids);
    const o = override?.(ids, calls.length);
    if (o) return Promise.resolve(o);
    const back = ids.filter((i) => alive.includes(i));
    if (back.length === 0) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(
      new Response(JSON.stringify({ _embedded: { leads: back.map((id) => ({ id, status_id: 10, pipeline_id: 1 })) } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const noSleep = () => Promise.resolve();

/** Deps reales contra el Kommo falso; registra lo aplicado y lo marcado. */
function httpDeps(controls: number[]) {
  const applied: number[] = [];
  const marked: number[] = [];
  const deps: ReconcileDeps = {
    fetchByIds: (ids) => fetchLeadsByIds("kommo.test", "tok", ids, noSleep),
    apply: (ls) => {
      applied.push(...ls.map((l) => l.id));
      return Promise.resolve(ls.length);
    },
    markMissing: (ids) => {
      marked.push(...ids);
      return Promise.resolve(ids.length);
    },
    controlCandidates: () => Promise.resolve(controls),
    sleep: noSleep,
  };
  return { deps, applied, marked };
}

const OPTS = { batchSize: 100, confirmBatchSize: 25, pauseMs: 250 };
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

Deno.test("Kommo falso: lote entero vacío (204) REAL, con control positivo que vuelve → se marcan todos", async () => {
  // El caso KIA: 150 leads viejos borrados, ningún vivo entre los candidatos.
  const gone = range(1000, 150);
  const k = withFakeKommo([7]); // 7 = control que sí existe
  try {
    const h = httpDeps([7]);
    const r = await reconcileLeadIds(gone, h.deps, OPTS);
    assertEquals(r.marked, 150);
    assertEquals(r.suspicious, false);
    assertEquals(r.unconfirmed, 0);
    assertEquals(h.marked.sort((a, b) => a - b), gone);
    // Cada pedido de confirmación lleva el control y como mucho 24 candidatos.
    const confirmations = k.calls.slice(2);
    assertEquals(confirmations.every((c) => c.includes(7) && c.length <= 25), true);
    assertEquals(h.applied.filter((i) => i !== 7), []); // solo el control se aplicó
  } finally {
    k.restore();
  }
});

Deno.test("Kommo falso: lote vacío SIN control disponible → no marca nada", async () => {
  const gone = range(1000, 60);
  const k = withFakeKommo([]);
  try {
    const h = httpDeps([]); // no hay ningún lead conocido vivo para usar de control
    const r = await reconcileLeadIds(gone, h.deps, OPTS);
    assertEquals(r.marked, 0);
    assertEquals(r.suspicious, true);
    assertEquals(r.unconfirmed, 60);
    assertEquals(h.marked, []);
  } finally {
    k.restore();
  }
});

Deno.test("Kommo falso: el control NO vuelve (respuesta vacía sospechosa) → ese lote no se marca", async () => {
  const gone = range(1000, 30);
  // Kommo «conoce» el 7, pero las confirmaciones vuelven 204 igual (vacío espurio).
  const k = withFakeKommo([7], (ids, call) => (call > 1 && ids.includes(7) ? new Response(null, { status: 204 }) : null));
  try {
    const h = httpDeps([7, 8, 9]);
    const r = await reconcileLeadIds(gone, h.deps, OPTS);
    assertEquals(r.marked, 0);
    assertEquals(r.suspicious, true);
    assertEquals(h.marked, []);
  } finally {
    k.restore();
  }
});

Deno.test("Kommo falso: 429 sostenido → error, no marca nada", async () => {
  const k = withFakeKommo([7], () => new Response("rate", { status: 429, headers: { "retry-after": "0" } }));
  try {
    const h = httpDeps([7]);
    await assertRejects(() => reconcileLeadIds(range(1000, 10), h.deps, OPTS), KommoHttpError);
    assertEquals(h.marked, []);
  } finally {
    k.restore();
  }
});

Deno.test("Kommo falso: 429 en la CONFIRMACIÓN → ese lote no se marca", async () => {
  const k = withFakeKommo([7], (_ids, call) => (call >= 2 ? new Response("rate", { status: 429 }) : null));
  try {
    const h = httpDeps([7]);
    await assertRejects(() => reconcileLeadIds(range(1000, 10), h.deps, OPTS), KommoHttpError);
    assertEquals(h.marked, []);
  } finally {
    k.restore();
  }
});

Deno.test("Kommo falso: 500 → error, no marca nada", async () => {
  const k = withFakeKommo([7], () => new Response("boom", { status: 500 }));
  try {
    const h = httpDeps([7]);
    await assertRejects(() => reconcileLeadIds(range(1000, 10), h.deps, OPTS), KommoHttpError, "500");
    assertEquals(h.marked, []);
  } finally {
    k.restore();
  }
});

Deno.test("Kommo falso: 200 mal formado (sin _embedded.leads / no JSON) → error, no marca nada", async () => {
  for (const body of ['{"_embedded":{}}', '{"error":"x"}', "<html>mantenimiento</html>", '{"_embedded":{"leads":"no"}}']) {
    const k = withFakeKommo([7], () => new Response(body, { status: 200 }));
    try {
      const h = httpDeps([7]);
      await assertRejects(() => reconcileLeadIds(range(1000, 10), h.deps, OPTS), KommoMalformedError);
      assertEquals(h.marked, [], body);
    } finally {
      k.restore();
    }
  }
});

Deno.test("Kommo falso: mal formado solo en la confirmación → no marca", async () => {
  const k = withFakeKommo([7], (_ids, call) => (call >= 2 ? new Response('{"_embedded":{}}', { status: 200 }) : null));
  try {
    const h = httpDeps([7]);
    await assertRejects(() => reconcileLeadIds(range(1000, 10), h.deps, OPTS), KommoMalformedError);
    assertEquals(h.marked, []);
  } finally {
    k.restore();
  }
});

Deno.test("Kommo falso: un lead devuelto SIN etapa/pipeline existe igual → no se marca", async () => {
  const k = withFakeKommo([7], (ids) =>
    ids.includes(1001)
      ? new Response(JSON.stringify({ _embedded: { leads: ids.filter((i) => i === 1001 || i === 7).map((id) => ({ id })) } }), { status: 200 })
      : null
  );
  try {
    const h = httpDeps([7]);
    const r = await reconcileLeadIds([1000, 1001], h.deps, OPTS);
    assertEquals(h.marked, [1000]);
    assertEquals(r.found, 1);
  } finally {
    k.restore();
  }
});

Deno.test("Kommo falso: mezcla — los vivos se aplican y sirven de control; solo los borrados se marcan", async () => {
  const ids = range(1, 120);
  const alive = ids.filter((i) => i % 3 === 0);
  const k = withFakeKommo(alive);
  try {
    const h = httpDeps([]); // no hace falta control externo: los vivos de la primera lectura alcanzan
    const r = await reconcileLeadIds(ids, h.deps, OPTS);
    assertEquals(r.found, alive.length);
    assertEquals(h.marked.sort((a, b) => a - b), ids.filter((i) => i % 3 !== 0));
    assertEquals(r.suspicious, false);
  } finally {
    k.restore();
  }
});

Deno.test("Kommo falso: una respuesta vacía PUNTUAL (la confirmación sí lo devuelve) aplica el lead y no lo marca", async () => {
  const k = withFakeKommo([7, 50], (_ids, call) => (call === 1 ? new Response(null, { status: 204 }) : null));
  try {
    const h = httpDeps([7]);
    const r = await reconcileLeadIds([50, 51], h.deps, OPTS);
    assertEquals(h.marked, [51]);
    assertEquals(h.applied.includes(50), true);
    assertEquals(r.found, 1);
  } finally {
    k.restore();
  }
});

Deno.test("Kommo falso: confirmación con otra página (_links.next) → no se marca aunque vuelva el control", async () => {
  const k = withFakeKommo([7], (ids, call) =>
    call >= 2
      ? new Response(JSON.stringify({ _embedded: { leads: ids.filter((i) => i === 7).map((id) => ({ id, status_id: 1, pipeline_id: 1 })) }, _links: { next: { href: "x" } } }), { status: 200 })
      : null
  );
  try {
    const h = httpDeps([7]);
    const r = await reconcileLeadIds(range(1000, 10), h.deps, OPTS);
    assertEquals(h.marked, []);
    assertEquals(r.suspicious, true);
    assertEquals(r.unconfirmed, 10);
  } finally {
    k.restore();
  }
});

// ---------------------------------------------------------------------------
// Lógica pura
// ---------------------------------------------------------------------------

/** `alive`: ids que Kommo conoce. Registra lotes pedidos, lo aplicado y lo marcado. */
function fake(alive: number[], opts: { failOnBatch?: number; controls?: number[] } = {}) {
  const batches: number[][] = [];
  const applied: number[] = [];
  const marked: number[][] = [];
  const slept: number[] = [];
  const deps: ReconcileDeps = {
    fetchByIds: (ids) => {
      batches.push(ids);
      if (opts.failOnBatch === batches.length) return Promise.reject(new Error("429 sostenido"));
      return Promise.resolve({ leads: ids.filter((i) => alive.includes(i)).map(lead), hasMore: false, readAtMs: 1234 });
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
    controlCandidates: () => Promise.resolve(opts.controls ?? []),
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
  return { deps, batches, applied, marked, slept };
}

Deno.test("un lead vivo que la paginación saltó se APLICA y no se marca; solo el ausente se marca", async () => {
  const f = fake([2]); // Kommo conoce el 2; el 3 se borró. El 2 sirve de control.
  const r = await reconcileLeadIds([2, 3], f.deps, OPTS);
  assertEquals(r, { checked: 2, found: 1, marked: 1, suspicious: false, unconfirmed: 0 });
  assertEquals(f.batches, [[2, 3], [3, 2]]);
  assertEquals(f.marked, [[3]]);
});

Deno.test("primera lectura en lotes de batchSize con pausa entre CADA pedido (no antes del primero)", async () => {
  const ids = range(1, 250);
  const f = fake(ids); // todos vivos: no hay confirmación
  const r = await reconcileLeadIds(ids, f.deps, OPTS);
  assertEquals(f.batches.map((b) => b.length), [100, 100, 50]);
  assertEquals(f.slept, [250, 250]);
  assertEquals(r.marked, 0);
  assertEquals(r.found, 250);
});

Deno.test("sin ids no llama a Kommo", async () => {
  const f = fake([]);
  assertEquals(await reconcileLeadIds([], f.deps, OPTS), { checked: 0, found: 0, marked: 0, suspicious: false, unconfirmed: 0 });
  assertEquals(f.batches.length, 0);
});

Deno.test("nunca marca con UNA sola lectura: los ausentes siempre pasan por la confirmación con control", async () => {
  const f = fake([99], { controls: [99] });
  const r = await reconcileLeadIds([7, 8], f.deps, OPTS);
  assertEquals(f.batches, [[7, 8], [7, 8, 99]]);
  assertEquals(r.marked, 2);
});

Deno.test("el control no puede ser uno de los ids que se están verificando", async () => {
  const f = fake([], { controls: [7, 8] }); // los «controles» son los propios candidatos
  const r = await reconcileLeadIds([7, 8], f.deps, OPTS);
  assertEquals(r.marked, 0);
  assertEquals(r.suspicious, true);
  assertEquals(f.batches.length, 1); // ni siquiera intenta confirmar
});

Deno.test("controles que fallan seguidos: abandona tras MAX_CONTROL_FAILURES sin marcar", async () => {
  // Los controles «existen» para la base pero Kommo no los devuelve (borrados).
  const f = fake([], { controls: [901, 902, 903, 904, 905] });
  const r = await reconcileLeadIds(range(1, 200), f.deps, OPTS);
  assertEquals(f.batches.length, 2 + MAX_CONTROL_FAILURES);
  assertEquals(r.marked, 0);
  assertEquals(r.suspicious, true);
  assertEquals(r.unconfirmed, 200);
});

Deno.test("un control que falla se descarta y el siguiente lote usa otro control", async () => {
  const f = fake([902], { controls: [901, 902] }); // 901 se borró; 902 vive
  const r = await reconcileLeadIds(range(1, 30), f.deps, OPTS); // 30 ausentes → 2 lotes de 24 + 6
  assertEquals(f.batches.slice(1).map((b) => b.at(-1)), [901, 902]);
  assertEquals(r.suspicious, true);
  // El lote que llevó el 901 no se marca: sus 24 ids siguen candidatos para la próxima pasada.
  assertEquals(r.marked, 6);
  assertEquals(r.unconfirmed, 24);
});

Deno.test("un error de Kommo a mitad corta: el lote en curso no se marca, lo ya confirmado sí", async () => {
  // 60 ausentes: confirmación en lotes 24+24+12; el 2º pedido de confirmación falla.
  const f = fake([], { controls: [999], failOnBatch: 3 });
  const deps = { ...f.deps, fetchByIds: (ids: number[]) => {
    const p = f.deps.fetchByIds(ids);
    // el control 999 vive
    return p.then((r) => ({ ...r, leads: ids.includes(999) ? [...r.leads, lead(999)] : r.leads }));
  } };
  await assertRejects(() => reconcileLeadIds(range(1, 60), deps, OPTS), Error, "429");
  assertEquals(f.marked, [range(1, 24)]);
});

Deno.test("tope de tiempo: no empieza pedidos nuevos y lo no confirmado queda candidato (sin marcar)", async () => {
  const f = fake([], { controls: [999] });
  let t = 0;
  const deps: ReconcileDeps = {
    ...f.deps,
    fetchByIds: async (ids) => {
      t += 10;
      const r = await f.deps.fetchByIds(ids);
      return { ...r, leads: ids.includes(999) ? [lead(999)] : [] };
    },
    now: () => t,
  };
  // 300 ids: 3 pedidos de primera lectura (t=30) + confirmaciones; deadline a t=50.
  const r = await reconcileLeadIds(range(1, 300), deps, { ...OPTS, deadlineMs: 50 });
  assertEquals(f.batches.length, 5);
  assertEquals(r.marked, 48);
  assertEquals(r.unconfirmed, 252);
});

Deno.test("heartbeat: se llama tras CADA pedido (lectura y confirmación) para renovar el lease", async () => {
  const ids = range(1, 250);
  const f = fake(ids.filter((i) => i % 25 !== 0)); // 10 ausentes repartidos
  let beats = 0;
  const r = await reconcileLeadIds(ids, { ...f.deps, heartbeat: () => { beats++; return Promise.resolve(); } }, OPTS);
  // 3 lotes de la primera lectura + 1 de confirmación (10 ausentes + control)
  assertEquals(beats, 4);
  assertEquals(r.marked, 10);
});

Deno.test("un lease perdido (heartbeat lanza) corta sin marcar lo que falta", async () => {
  const f = fake([], { controls: [999] });
  let beats = 0;
  const deps: ReconcileDeps = {
    ...f.deps,
    fetchByIds: async (ids) => {
      const r = await f.deps.fetchByIds(ids);
      return { ...r, leads: ids.includes(999) ? [lead(999)] : [] };
    },
    heartbeat: () => {
      beats++;
      return beats === 1 ? Promise.resolve() : Promise.reject(new Error("lease perdido"));
    },
  };
  await assertRejects(() => reconcileLeadIds(range(1, 50), deps, OPTS), Error, "lease perdido");
  // La primera confirmación (24) se marcó antes del latido que falló; nada más.
  assertEquals(f.marked, [range(1, 24)]);
});
