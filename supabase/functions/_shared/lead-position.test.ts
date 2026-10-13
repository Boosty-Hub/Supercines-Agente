// _shared/lead-position.test.ts
// Deno tests de la lógica PURA con que process-inbound decide qué hacer cuando
// Kommo avisa que un lead cambió (leads.update / leads.status).
//
// Correr con: deno test --allow-read supabase/functions/_shared/lead-position.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { parseLeadPosition, planPositionChange } from "./lead-position.ts";

// ---- parseLeadPosition ----

Deno.test("parseLeadPosition: el webhook manda strings; los pasa a número", () => {
  assertEquals(parseLeadPosition({ id: "123", status_id: "142", pipeline_id: "9" }), {
    kommoLeadId: 123,
    statusId: 142,
    pipelineId: 9,
  });
});

Deno.test("parseLeadPosition: sin status_id no hay posición (es un cambio de otro campo)", () => {
  assertEquals(parseLeadPosition({ id: "123", name: "x" }), null);
});

Deno.test("parseLeadPosition: pipeline_id ausente se conserva como null, no descarta la etapa", () => {
  assertEquals(parseLeadPosition({ id: 5, status_id: 77 }), { kommoLeadId: 5, statusId: 77, pipelineId: null });
});

Deno.test("parseLeadPosition: ids no numéricos o 0 se descartan", () => {
  assertEquals(parseLeadPosition({ id: "abc", status_id: "1" }), null);
  assertEquals(parseLeadPosition({ id: "1", status_id: "xyz" }), null);
  assertEquals(parseLeadPosition({ id: "1", status_id: "0" }), null);
});

// ---- planPositionChange ----

Deno.test("planPositionChange: misma etapa y mismo pipeline = no se escribe NADA", () => {
  // ~1.900 de cada ~2.200 leads.update por semana son de otros campos (tags,
  // precio...). Escribir en cada uno dispararía un refresco en todos los inbox.
  const plan = planPositionChange({ stageId: 10, pipelineId: 1 }, { stageId: 10, pipelineId: 1 });
  assertEquals(plan, { write: false, patch: {}, recordEvent: false });
});

Deno.test("planPositionChange: cambio de etapa dentro del pipeline = escribe y registra evento", () => {
  const plan = planPositionChange({ stageId: 10, pipelineId: 1 }, { stageId: 11, pipelineId: 1 });
  assertEquals(plan, {
    write: true,
    patch: { kommo_stage_id: 11, kommo_pipeline_id: 1 },
    recordEvent: true,
  });
});

Deno.test("planPositionChange: 142 en otro pipeline ES un movimiento aunque el id de etapa no cambie", () => {
  const plan = planPositionChange({ stageId: 142, pipelineId: 1 }, { stageId: 142, pipelineId: 2 });
  assertEquals(plan.write, true);
  assertEquals(plan.recordEvent, true);
  assertEquals(plan.patch, { kommo_stage_id: 142, kommo_pipeline_id: 2 });
});

Deno.test("planPositionChange: primera vez que vemos la etapa (null) escribe pero NO es un movimiento", () => {
  const plan = planPositionChange({ stageId: null, pipelineId: null }, { stageId: 10, pipelineId: 1 });
  assertEquals(plan, {
    write: true,
    patch: { kommo_stage_id: 10, kommo_pipeline_id: 1 },
    recordEvent: false,
  });
});

Deno.test("planPositionChange: solo faltaba el pipeline (etapa igual) completa el dato sin evento", () => {
  const plan = planPositionChange({ stageId: 10, pipelineId: null }, { stageId: 10, pipelineId: 1 });
  assertEquals(plan, {
    write: true,
    patch: { kommo_stage_id: 10, kommo_pipeline_id: 1 },
    recordEvent: false,
  });
});

Deno.test("planPositionChange: webhook sin pipeline_id no pisa el pipeline guardado", () => {
  const plan = planPositionChange({ stageId: 10, pipelineId: 1 }, { stageId: 11, pipelineId: null });
  assertEquals(plan.write, true);
  assertEquals(plan.patch, { kommo_stage_id: 11 });
  assertEquals(plan.recordEvent, true);
});
