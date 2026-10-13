// _shared/lead-position.test.ts
// Deno tests de la extracción de posición e instante de un leads.update/status.
// (El orden y la detección de movimientos se prueban contra Postgres:
// supabase/tests/claim_kommo_backfill.sql.)
//
// Correr con: deno test --allow-read supabase/functions/_shared/lead-position.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { eventInstantMs, MAX_FUTURE_SKEW_MS, parseLeadPosition } from "./lead-position.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");

Deno.test("parseLeadPosition: el webhook manda strings; los pasa a número y toma last_modified en ms", () => {
  assertEquals(parseLeadPosition({ id: "123", status_id: "142", pipeline_id: "9", last_modified: String(Math.floor(NOW / 1000) - 30) }, NOW), {
    kommoLeadId: 123,
    statusId: 142,
    pipelineId: 9,
    atMs: NOW - 30_000,
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

const secs = (ms: number) => Math.floor(ms / 1000);

Deno.test("eventInstantMs: last_modified gana sobre updated_at, y ambos sobre la llegada", () => {
  const a = secs(NOW) - 100;
  const b = secs(NOW) - 50;
  assertEquals(eventInstantMs({ last_modified: a, updated_at: b }, NOW), a * 1000);
  assertEquals(eventInstantMs({ updated_at: b }, NOW), b * 1000);
  assertEquals(eventInstantMs({}, NOW), NOW);
});

Deno.test("eventInstantMs: basura o 0 cae a la hora de llegada", () => {
  assertEquals(eventInstantMs({ last_modified: "abc" }, NOW), NOW);
  assertEquals(eventInstantMs({ last_modified: "0" }, NOW), NOW);
});

Deno.test("eventInstantMs: fecha FUTURA (ataque al webhook) se recorta a llegada + 2 min, no congela al lead", () => {
  assertEquals(eventInstantMs({ last_modified: secs(NOW) + 3600 }, NOW), NOW + MAX_FUTURE_SKEW_MS);
  // el evento real que llega después queda por encima del recortado: no se descarta como «viejo»
  const real = eventInstantMs({ last_modified: secs(NOW) + 600 }, NOW + 600_000);
  assertEquals(real > NOW + MAX_FUTURE_SKEW_MS, true);
});

Deno.test("eventInstantMs: futuro lejano o pasado absurdo usan la hora de llegada", () => {
  assertEquals(eventInstantMs({ last_modified: "9999999999" }, NOW), NOW);
  assertEquals(eventInstantMs({ last_modified: 1000 }, NOW), NOW);
  assertEquals(eventInstantMs({ last_modified: secs(NOW) - 8 * 86400 }, NOW), NOW);
});

Deno.test("eventInstantMs: desfase de reloj chico hacia el futuro se respeta", () => {
  const t = secs(NOW) + 60;
  assertEquals(eventInstantMs({ last_modified: t }, NOW), t * 1000);
});

Deno.test("eventInstantMs: orden invertido LEGÍTIMO (el viejo llega después) conserva el orden de Kommo", () => {
  const nuevo = eventInstantMs({ last_modified: secs(NOW) - 10 }, NOW);
  const viejo = eventInstantMs({ last_modified: secs(NOW) - 300 }, NOW + 1000); // llegó DESPUÉS
  assertEquals(viejo < nuevo, true);
});
