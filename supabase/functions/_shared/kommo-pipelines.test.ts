// _shared/kommo-pipelines.test.ts
// Deno tests de la lectura de pipelines y de la paginación de leads con que se
// rellena kommo_pipeline_id (Edge Function sync-pipelines).
//
// Correr con: deno test --allow-read supabase/functions/_shared/kommo-pipelines.test.ts

import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import {
  fetchLeadsByIds,
  fetchLeadsPositionsPage,
  fetchPipelinesFull,
  flattenPipelines,
  KommoHttpError,
} from "./kommo.ts";

function withFetchMock<T>(mock: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const noSleep = () => Promise.resolve();

Deno.test("fetchPipelinesFull: conserva orden, tipo y color de las etapas", async () => {
  const mock = (() =>
    Promise.resolve(
      json({
        _embedded: {
          pipelines: [
            {
              id: 1,
              name: "Ventas",
              sort: 2,
              is_main: true,
              _embedded: {
                statuses: [
                  { id: 10, name: "Nuevo", sort: 10, type: 1, color: "#99ccff" },
                  { id: 142, name: "Ganado", sort: 10000 },
                ],
              },
            },
          ],
        },
      }),
    )) as typeof fetch;
  const pipelines = await withFetchMock(mock, () => fetchPipelinesFull("x.kommo.com", "tok"));
  assertEquals(pipelines, [
    {
      id: 1,
      name: "Ventas",
      sort: 2,
      is_main: true,
      is_archive: false,
      statuses: [
        { id: 10, name: "Nuevo", sort: 10, type: 1, color: "#99ccff" },
        { id: 142, name: "Ganado", sort: 10000, type: 0, color: null },
      ],
    },
  ]);
  assertEquals(flattenPipelines(pipelines).map((s) => [s.id, s.pipelineId]), [
    [10, 1],
    [142, 1],
  ]);
});

Deno.test("fetchLeadsPositionsPage: devuelve id/etapa/pipeline y detecta que hay más páginas", async () => {
  let pedida = "";
  const mock = ((input: string | URL | Request) => {
    pedida = String(input);
    return Promise.resolve(
      json({
        _embedded: {
          leads: [
            { id: 1, status_id: 10, pipeline_id: 1, name: "ruido" },
            { id: 2, status_id: 143, pipeline_id: 2 },
            { id: 3, name: "sin etapa" },
          ],
        },
        _links: { next: { href: "..." } },
      }),
    );
  }) as typeof fetch;
  const r = await withFetchMock(mock, () => fetchLeadsPositionsPage("x.kommo.com", "tok", 3, 250, noSleep));
  assertEquals(r.leads, [
    { id: 1, status_id: 10, pipeline_id: 1 },
    { id: 2, status_id: 143, pipeline_id: 2 },
  ]);
  assertEquals(typeof r.readAtMs, "number");
  assertEquals(r.hasMore, true);
  // orden estable por id: la paginación no se corre si entran leads nuevos.
  assertEquals(pedida.includes("order[id]=asc") && pedida.includes("page=3") && pedida.includes("limit=250"), true);
});

Deno.test("fetchLeadsPositionsPage: 204 = no hay más leads", async () => {
  const mock = (() => Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch;
  const r = await withFetchMock(mock, () => fetchLeadsPositionsPage("x.kommo.com", "tok", 9, 250, noSleep));
  assertEquals({ leads: r.leads, hasMore: r.hasMore }, { leads: [], hasMore: false });
});

Deno.test("fetchLeadsPositionsPage: ante 429 espera Retry-After y reintenta", async () => {
  let llamadas = 0;
  const esperas: number[] = [];
  const mock = (() => {
    llamadas++;
    if (llamadas < 3) return Promise.resolve(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }));
    return Promise.resolve(json({ _embedded: { leads: [{ id: 1, status_id: 5, pipeline_id: 1 }] } }));
  }) as typeof fetch;
  const r = await withFetchMock(mock, () =>
    fetchLeadsPositionsPage("x.kommo.com", "tok", 1, 250, (ms) => {
      esperas.push(ms);
      return Promise.resolve();
    }),
  );
  assertEquals(llamadas, 3);
  assertEquals(esperas, [2000, 2000]);
  assertEquals(r.leads.length, 1);
});

Deno.test("fetchLeadsPositionsPage: 429 sostenido termina en error, no en bucle infinito", async () => {
  let llamadas = 0;
  const mock = (() => {
    llamadas++;
    return Promise.resolve(new Response("slow", { status: 429 }));
  }) as typeof fetch;
  const err = await withFetchMock(mock, () =>
    assertRejects(() => fetchLeadsPositionsPage("x.kommo.com", "tok", 1, 250, noSleep), KommoHttpError),
  );
  assertEquals((err as KommoHttpError).status, 429);
  assertEquals(llamadas, 5); // 1 + 4 reintentos
});

Deno.test("fetchLeadsPositionsPage: 401 sale como KommoHttpError con el status (token vencido)", async () => {
  const mock = (() => Promise.resolve(new Response("unauthorized", { status: 401 }))) as typeof fetch;
  const err = await withFetchMock(mock, () =>
    assertRejects(() => fetchLeadsPositionsPage("x.kommo.com", "tok", 1, 250, noSleep), KommoHttpError),
  );
  assertEquals((err as KommoHttpError).status, 401);
});

Deno.test("fetchLeadsByIds: manda filter[id][] y devuelve solo los leads que Kommo conoce", async () => {
  let pedida = "";
  const mock = ((input: string | URL | Request) => {
    pedida = String(input);
    return Promise.resolve(json({ _embedded: { leads: [{ id: 7, status_id: 10, pipeline_id: 1 }] } }));
  }) as typeof fetch;
  const r = await withFetchMock(mock, () => fetchLeadsByIds("x.kommo.com", "tok", [7, 8, 9], noSleep));
  assertEquals(r.leads, [{ id: 7, status_id: 10, pipeline_id: 1 }]);
  assertEquals(
    pedida.includes("filter[id][]=7&filter[id][]=8&filter[id][]=9") && pedida.includes("limit=100"),
    true,
  );
});

Deno.test("fetchLeadsByIds: 204 = ninguno existe; sin ids no pregunta; más de 100 ids es un error de uso", async () => {
  let llamadas = 0;
  const mock = (() => {
    llamadas++;
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const vacio = await withFetchMock(mock, () => fetchLeadsByIds("x.kommo.com", "tok", [1, 2], noSleep));
  assertEquals(vacio.leads, []);
  await withFetchMock(mock, () => fetchLeadsByIds("x.kommo.com", "tok", [], noSleep));
  assertEquals(llamadas, 1);
  let lanzo = false;
  try {
    fetchLeadsByIds("x.kommo.com", "tok", Array.from({ length: 101 }, (_, i) => i + 1), noSleep);
  } catch {
    lanzo = true;
  }
  assertEquals(lanzo, true);
});
