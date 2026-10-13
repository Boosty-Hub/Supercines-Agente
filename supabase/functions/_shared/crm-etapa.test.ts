// _shared/crm-etapa.test.ts
// Deno tests para la resolución PURA de etapa por nombre, compartida por
// `mover_etapa` y `transferir_asesor` en generate-response/index.ts.
//
// Correr con: deno test --allow-read supabase/functions/_shared/crm-etapa.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { normalizarTexto, resolverEtapa } from "./crm-etapa.ts";
import type { KommoStageLite } from "./kommo.ts";

function stage(id: number, name: string, pipelineId: number, pipelineName: string): KommoStageLite {
  return { id, name, pipelineId, pipelineName };
}

// ---- normalizarTexto ----

Deno.test("normalizarTexto: baja a minúsculas y saca acentos", () => {
  assertEquals(normalizarTexto("Atención Humana"), "atencion humana");
});

Deno.test("normalizarTexto: recorta espacios en los extremos", () => {
  assertEquals(normalizarTexto("  Ganado  "), "ganado");
});

Deno.test("normalizarTexto: string vacío o undefined no explota", () => {
  assertEquals(normalizarTexto(""), "");
  // deno-lint-ignore no-explicit-any
  assertEquals(normalizarTexto(undefined as any), "");
});

// ---- resolverEtapa ----

Deno.test("resolverEtapa: match exacto único", () => {
  const stages = [stage(1, "Nuevo", 10, "Ventas"), stage(2, "Ganado", 10, "Ventas")];
  const r = resolverEtapa(stages, "Ganado", "");
  assertEquals(r, { ok: true, etapa: stage(2, "Ganado", 10, "Ventas") });
});

Deno.test("resolverEtapa: matchea ignorando mayúsculas y acentos", () => {
  const stages = [stage(1, "Atención Humana", 10, "Ventas")];
  const r = resolverEtapa(stages, "atencion humana", "");
  assertEquals(r.ok, true);
});

Deno.test("resolverEtapa: sin coincidencias devuelve error con las etapas disponibles", () => {
  const stages = [stage(1, "Nuevo", 10, "Ventas")];
  const r = resolverEtapa(stages, "Ganado", "");
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.texto.includes("No encontré"), true);
    assertEquals(r.texto.includes('"Nuevo" (pipeline "Ventas")'), true);
  }
});

Deno.test("resolverEtapa: sin etapas cargadas, el listado de disponibles queda vacío pero no rompe", () => {
  const r = resolverEtapa([], "Ganado", "");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.texto.includes("(ninguna)"), true);
});

Deno.test("resolverEtapa: ambigua entre pipelines sin pipelineName", () => {
  const stages = [stage(1, "Ganado", 10, "Ventas"), stage(2, "Ganado", 20, "Postventa")];
  const r = resolverEtapa(stages, "Ganado", "");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.texto.includes("existe en varios pipelines"), true);
});

Deno.test("resolverEtapa: pipelineName desambigua correctamente", () => {
  const stages = [stage(1, "Ganado", 10, "Ventas"), stage(2, "Ganado", 20, "Postventa")];
  const r = resolverEtapa(stages, "Ganado", "Postventa");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.etapa.pipelineId, 20);
});

Deno.test("resolverEtapa: pipelineName que no matchea ninguna de las candidatas cae en 'no encontré'", () => {
  const stages = [stage(1, "Ganado", 10, "Ventas")];
  const r = resolverEtapa(stages, "Ganado", "Postventa");
  assertEquals(r.ok, false);
});
