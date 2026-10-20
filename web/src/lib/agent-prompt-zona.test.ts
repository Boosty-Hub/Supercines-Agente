// La tool derivar_a_zona se declara con el gate de mover de etapa y el scaffold la presenta
// como excepción a «nada de CRM por iniciativa propia» SOLO cuando está declarada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCrmActionsBlock, filterToolRowsByGates } from "./agent-prompt.ts";

const row = { name: "derivar_a_zona", description: "x", tool_type: "system" } as Parameters<typeof filterToolRowsByGates>[0][number];

test("derivar_a_zona: mismo gate que mover_etapa (fail-closed)", () => {
  assert.equal(filterToolRowsByGates([row], { crm_actions_enabled: true, crm_can_move_stage: true }).length, 1);
  assert.equal(filterToolRowsByGates([row], { crm_actions_enabled: true, crm_can_move_stage: false }).length, 0);
  assert.equal(filterToolRowsByGates([row], { crm_actions_enabled: false, crm_can_move_stage: true }).length, 0);
  assert.equal(filterToolRowsByGates([row], null).length, 0);
});

test("derivar_a_zona: el bloque de CRM la nombra y la exceptúa solo si está declarada", () => {
  const con = buildCrmActionsBlock(["mover_etapa", "derivar_a_zona"]);
  assert.match(con, /`derivar_a_zona`/);
  assert.match(con, /EXCEPCIÓN: `derivar_a_zona`/);
  const sin = buildCrmActionsBlock(["mover_etapa"]);
  assert.doesNotMatch(sin, /derivar_a_zona/);
});
