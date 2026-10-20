// derivar-zona.test.ts — resolver puro de zonas (zonas.ts) y comportamiento de la tool
// derivar_a_zona (derivar-zona.ts) con Kommo y base FALSOS.
//   deno test --allow-read supabase/functions/_shared/derivar-zona.test.ts
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { derivarAZona, type DerivarDeps, type LeadEnVivo } from "./derivar-zona.ts";
import {
  type EspejoEtapa,
  parseZonasConfig,
  resolverZona,
  resolverZonaEnEspejo,
  sinResponsable,
} from "./zonas.ts";

const CONFIG = JSON.stringify([
  {
    zona: "CCS", pipeline: "Ventas Zona CCS", asesor: "Laura Frontado", whatsapp: "+58 424-3218200",
    sedes: ["La Cascada", "Puente Real"], alias: ["Caracas", "Barcelona", "Anzoátegui", "Altos Mirandinos"],
  },
  {
    zona: "VAL", pipeline: "Ventas Zona VAL", etapa: "Contacto inicial", asesor: "Franairy Feo",
    whatsapp: "+58 424-3609571", sedes: ["La Granja", "Playa Mar"], alias: ["Valencia", "Puerto Cabello"],
  },
  {
    zona: "MRCAY", pipeline: "Ventas Zona MRCAY", asesor: "Karla Herrera", whatsapp: "0424-3218180",
    sedes: ["Unicentro", "Los Aviadores"], alias: ["Maracay"],
  },
]);
const ZONAS = (() => {
  const p = parseZonasConfig(CONFIG);
  if (!p.ok) throw new Error(p.error);
  return p.zonas;
})();

const e = (pipeline_id: number, pipeline_name: string, id: number, name: string, type: number, sort: number): EspejoEtapa =>
  ({ pipeline_id, pipeline_name, id, name, type, sort });
const ESPEJO: EspejoEtapa[] = [
  e(1, "Redes - Cine", 10, "Incoming leads", 1, 10),
  e(1, "Redes - Cine", 11, "info Cine", 0, 20),
  e(1, "Redes - Cine", 143, "Closed - lost", 0, 11000),
  e(2, "Ventas Zona CCS", 20, "Incoming leads", 1, 10),
  e(2, "Ventas Zona CCS", 21, "Contacto inicial", 0, 20),
  e(2, "Ventas Zona CCS", 22, "Interesado", 0, 30),
  e(2, "Ventas Zona CCS", 142, "Leads ganados", 0, 10000),
  e(2, "Ventas Zona CCS", 143, "Leads perdidos", 0, 11000),
  e(3, "Ventas Zona VAL", 30, "Incoming leads", 1, 10),
  e(3, "Ventas Zona VAL", 31, "Contacto inicial", 0, 20),
  e(4, "Ventas Zona MRCAY", 40, "Incoming leads", 1, 10),
  e(4, "Ventas Zona MRCAY", 41, "Contacto inicial", 0, 20),
];
const LAURA = 100, FRANAIRY = 200, KARLA = 300, GENERICA = 999, GERENTE = 555;
const ASIGNABLES = [
  { kommo_user_id: LAURA, display_name: "Laura Frontado" },
  { kommo_user_id: FRANAIRY, display_name: "Franairy Feo" },
  { kommo_user_id: KARLA, display_name: "Karla Herrera" },
];

// ---- Resolver puro --------------------------------------------------------------------

Deno.test("resolverZona: sedes y ciudades, sin acentos ni mayúsculas", () => {
  assertEquals(resolverZona("La Cascada", ZONAS)?.zona.zona, "CCS");
  assertEquals(resolverZona("puente real", ZONAS)?.zona.zona, "CCS");
  assertEquals(resolverZona("ANZOATEGUI", ZONAS)?.zona.zona, "CCS");
  assertEquals(resolverZona("estoy en Caracas", ZONAS)?.zona.zona, "CCS");
  assertEquals(resolverZona("Altos Mirandinos", ZONAS)?.zona.zona, "CCS");
  assertEquals(resolverZona("valencia", ZONAS)?.zona.zona, "VAL");
  assertEquals(resolverZona("Playa Mar", ZONAS)?.zona.zona, "VAL");
  assertEquals(resolverZona("Puerto Cabello", ZONAS)?.zona.zona, "VAL");
  assertEquals(resolverZona("Los Aviadores", ZONAS)?.zona.zona, "MRCAY");
  assertEquals(resolverZona("maracay", ZONAS)?.zona.zona, "MRCAY");
});

Deno.test("resolverZona: desconocido, vacío o fragmento de palabra → null", () => {
  assertEquals(resolverZona("Mérida", ZONAS), null);
  assertEquals(resolverZona("", ZONAS), null);
  assertEquals(resolverZona("valencianos", ZONAS), null);
});

Deno.test("resolverZona: términos de dos zonas = ambiguo → null; dos de la misma zona, ok", () => {
  assertEquals(resolverZona("Valencia o Maracay", ZONAS), null);
  assertEquals(resolverZona("La Granja, vivo en Caracas", ZONAS), null);
  assertEquals(resolverZona("La Granja en Valencia", ZONAS)?.zona.zona, "VAL");
});

Deno.test("resolverZona: un término contenido en otro más largo no cuenta", () => {
  const p = parseZonasConfig(JSON.stringify([
    { zona: "A", pipeline: "PA", asesor: "X", sedes: ["Valencia"] },
    { zona: "B", pipeline: "PB", asesor: "Y", sedes: ["Valencia Norte"] },
  ]));
  assert(p.ok);
  if (p.ok) assertEquals(resolverZona("sala en Valencia Norte", p.zonas)?.zona.zona, "B");
});

Deno.test("parseZonasConfig valida forma", () => {
  assertEquals(parseZonasConfig("").ok, true);
  assertEquals(parseZonasConfig("{").ok, false);
  assertEquals(parseZonasConfig("{}").ok, false);
  assertEquals(parseZonasConfig('[{"zona":"X","pipeline":"P","asesor":"A"}]').ok, false);
});

Deno.test("resolverZonaEnEspejo: etapa de entrada = primera de trabajo; nombre explícito; errores", () => {
  const ccs = resolverZonaEnEspejo(ZONAS[0], ESPEJO, ASIGNABLES);
  assert(ccs.ok);
  if (ccs.ok) {
    assertEquals(ccs.zona.stageId, 21); // no «Incoming leads» (type 1)
    assertEquals(ccs.zona.pipelineId, 2);
    assertEquals(ccs.zona.asesorUserId, LAURA);
  }
  const val = resolverZonaEnEspejo(ZONAS[1], ESPEJO, ASIGNABLES);
  assert(val.ok && val.zona.stageId === 31);
  assertEquals(resolverZonaEnEspejo(ZONAS[0], ESPEJO.filter((x) => x.pipeline_id !== 2), ASIGNABLES).ok, false);
  assertEquals(resolverZonaEnEspejo(ZONAS[0], ESPEJO, ASIGNABLES.filter((a) => a.kommo_user_id !== LAURA)).ok, false);
});

Deno.test("sinResponsable: 0, null, undefined y NaN = sin dueño", () => {
  assertEquals(sinResponsable(0), true);
  assertEquals(sinResponsable(null), true);
  assertEquals(sinResponsable(undefined), true);
  assertEquals(sinResponsable(Number.NaN), true);
  assertEquals(sinResponsable(LAURA), false);
});

// ---- Tool con fakes ---------------------------------------------------------------------

type Llamadas = { mover: Array<[number, number]>; asignar: number[]; notas: string[]; posiciones: unknown[]; ruteos: Array<Record<string, unknown>> };

function fakes(lead: LeadEnVivo, opts: { falla?: "mover" | "asignar" | "leer"; config?: string } = {}) {
  const ll: Llamadas = { mover: [], asignar: [], notas: [], posiciones: [], ruteos: [] };
  const deps: DerivarDeps = {
    zonas: () => Promise.resolve(parseZonasConfig(opts.config ?? CONFIG)),
    espejo: () => Promise.resolve(ESPEJO),
    asignables: () => Promise.resolve(ASIGNABLES),
    cuentasGenericas: () => Promise.resolve(new Set([GENERICA])),
    leerLead: () => opts.falla === "leer" ? Promise.reject(new Error("500")) : Promise.resolve(lead),
    moverEnKommo: (s, p) => {
      if (opts.falla === "mover") return Promise.reject(new Error("400"));
      ll.mover.push([s, p]);
      return Promise.resolve();
    },
    asignarEnKommo: (u) => {
      if (opts.falla === "asignar") return Promise.reject(new Error("400"));
      ll.asignar.push(u);
      return Promise.resolve();
    },
    notaEnKommo: (t) => { ll.notas.push(t); return Promise.resolve(); },
    registrarPosicion: (p) => { ll.posiciones.push(p); return Promise.resolve(); },
    registrarRuteo: (p) => { ll.ruteos.push(p); return Promise.resolve(); },
    log: () => {},
  };
  return { deps, ll };
}

Deno.test("derivar: lead de redes sin dueño (responsable 0) → mueve a la zona, asigna, nota, registra", async () => {
  const { deps, ll } = fakes({ statusId: 11, pipelineId: 1, responsibleUserId: 0 });
  const r = await derivarAZona({ sede: "Puente Real", motivo: "Cumpleaños para 30 niños" }, deps);
  assertEquals(ll.mover, [[21, 2]]);
  assertEquals(ll.asignar, [LAURA]);
  assertEquals(ll.notas.length, 1);
  assertStringIncludes(ll.notas[0], "zona CCS");
  assertStringIncludes(ll.notas[0], "Cumpleaños para 30 niños");
  assertEquals((ll.posiciones[0] as { fromStageName: string }).fromStageName, "info Cine");
  assertEquals(ll.ruteos[0].userId, LAURA);
  assertStringIncludes(r, "Listo");
  assertStringIncludes(r, "+58 424-3218200");
});

Deno.test("derivar: ya en el embudo de la zona → no mueve; corrige la asesora de otra zona", async () => {
  const { deps, ll } = fakes({ statusId: 22, pipelineId: 2, responsibleUserId: KARLA });
  await derivarAZona({ sede: "La Cascada" }, deps);
  assertEquals(ll.mover, []);
  assertEquals(ll.posiciones, []);
  assertEquals(ll.asignar, [LAURA]);
});

Deno.test("derivar: idempotente — ya en la zona y con la asesora correcta → no escribe nada en Kommo", async () => {
  const { deps, ll } = fakes({ statusId: 21, pipelineId: 2, responsibleUserId: LAURA });
  const r = await derivarAZona({ sede: "Caracas" }, deps);
  assertEquals(ll.mover, []);
  assertEquals(ll.asignar, []);
  assertEquals(ll.notas, []);
  assertStringIncludes(r, "Listo");
});

Deno.test("derivar: cuenta genérica se reemplaza; una persona ajena al ruteo NO", async () => {
  const gen = fakes({ statusId: 11, pipelineId: 1, responsibleUserId: GENERICA });
  await derivarAZona({ sede: "Valencia" }, gen.deps);
  assertEquals(gen.ll.asignar, [FRANAIRY]);

  const ajena = fakes({ statusId: 11, pipelineId: 1, responsibleUserId: GERENTE });
  await derivarAZona({ sede: "Valencia" }, ajena.deps);
  assertEquals(ajena.ll.mover, [[31, 3]]);
  assertEquals(ajena.ll.asignar, []);
  assertEquals(ajena.ll.ruteos[0].userId, null);
});

Deno.test("derivar: cerrado dentro de un embudo de ventas → no reabre ni reasigna", async () => {
  const { deps, ll } = fakes({ statusId: 143, pipelineId: 2, responsibleUserId: KARLA });
  const r = await derivarAZona({ sede: "La Cascada" }, deps);
  assertEquals(ll.mover, []);
  assertEquals(ll.asignar, []);
  assertStringIncludes(r, "se queda donde está");
});

Deno.test("derivar: cerrado en el embudo de redes → sí se deriva", async () => {
  const { deps, ll } = fakes({ statusId: 143, pipelineId: 1, responsibleUserId: null });
  await derivarAZona({ sede: "Maracay" }, deps);
  assertEquals(ll.mover, [[41, 4]]);
  assertEquals(ll.asignar, [KARLA]);
});

Deno.test("derivar: sede desconocida o vacía → pide confirmar, sin tocar Kommo", async () => {
  const { deps, ll } = fakes({ statusId: 11, pipelineId: 1, responsibleUserId: 0 });
  const r = await derivarAZona({ sede: "Mérida" }, deps);
  assertStringIncludes(r, "No reconozco");
  assertStringIncludes(r, "La Cascada");
  assertStringIncludes(await derivarAZona({}, deps), "ERROR_VALIDACION");
  assertEquals(ll.mover.length + ll.asignar.length + ll.notas.length, 0);
});

Deno.test("derivar: Kommo rechaza el movimiento → no asigna, devuelve el contacto igual", async () => {
  const { deps, ll } = fakes({ statusId: 11, pipelineId: 1, responsibleUserId: 0 }, { falla: "mover" });
  const r = await derivarAZona({ sede: "Unicentro" }, deps);
  assertEquals(ll.asignar, []);
  assertEquals(ll.ruteos[0].ok, false);
  assertStringIncludes(r, "0424-3218180");
});

Deno.test("derivar: sin config de zonas → no escribe y deriva a search_kb", async () => {
  const { deps, ll } = fakes({ statusId: 11, pipelineId: 1, responsibleUserId: 0 }, { config: "" });
  const r = await derivarAZona({ sede: "La Granja" }, deps);
  assertStringIncludes(r, "search_kb");
  assertEquals(ll.mover, []);
});
