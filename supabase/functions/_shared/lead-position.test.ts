// _shared/lead-position.test.ts
// Deno tests de la extracción de posición e instante de un leads.update/status.
// (El orden y la detección de movimientos se prueban contra Postgres:
// supabase/tests/claim_kommo_backfill.sql.)
//
// Correr con: deno test --allow-read supabase/functions/_shared/lead-position.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { eventInstantMs, parseLeadPosition } from "./lead-position.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");

Deno.test("parseLeadPosition: el webhook manda strings; los pasa a número y toma last_modified en ms", () => {
  assertEquals(parseLeadPosition({ id: "123", status_id: "142", pipeline_id: "9", last_modified: "1760356000" }, NOW), {
    kommoLeadId: 123,
    statusId: 142,
    pipelineId: 9,
    atMs: 1760356000_000,
  });
});

Deno.test("parseLeadPosition: sin status_id no hay posición (es un cambio de otro campo)", () => {
  assertEquals(parseLeadPosition({ id: "123", name: "x" }, NOW), null);
});

Deno.test("parseLeadPosition: pipeline_id ausente se conserva como null, no descarta la etapa", () => {
  assertEquals(parseLeadPosition({ id: 5, status_id: 77 }, NOW), {
    kommoLeadId: 5,
    statusId: 77,
    pipelineId: null,
    atMs: NOW,
  });
});

Deno.test("parseLeadPosition: ids no numéricos o 0 se descartan", () => {
  assertEquals(parseLeadPosition({ id: "abc", status_id: "1" }, NOW), null);
  assertEquals(parseLeadPosition({ id: "1", status_id: "xyz" }, NOW), null);
  assertEquals(parseLeadPosition({ id: "1", status_id: "0" }, NOW), null);
});

Deno.test("eventInstantMs: last_modified gana sobre updated_at, y ambos sobre la llegada", () => {
  assertEquals(eventInstantMs({ last_modified: 100, updated_at: 200 }, NOW), 100_000);
  assertEquals(eventInstantMs({ updated_at: 200 }, NOW), 200_000);
  assertEquals(eventInstantMs({}, NOW), NOW);
});

Deno.test("eventInstantMs: un instante absurdo (futuro lejano / basura) cae a la hora de llegada", () => {
  assertEquals(eventInstantMs({ last_modified: "9999999999" }, NOW), NOW);
  assertEquals(eventInstantMs({ last_modified: "abc" }, NOW), NOW);
  assertEquals(eventInstantMs({ last_modified: "0" }, NOW), NOW);
});

Deno.test("eventInstantMs: dos eventos del mismo lead conservan su orden aunque lleguen invertidos", () => {
  const viejo = eventInstantMs({ last_modified: 1000 }, NOW);
  const nuevo = eventInstantMs({ last_modified: 2000 }, NOW - 5_000);
  assertEquals(viejo < nuevo, true);
});
