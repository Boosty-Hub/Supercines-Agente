import test from "node:test";
import assert from "node:assert/strict";
import { DREAMS_FREQUENCIES, DREAMS_FREQUENCY_OPTIONS, frequencyChangeValues } from "./dreams-frequency.ts";

test("las frecuencias de Dreams incluyen el apagado", () => {
  assert.deepEqual([...DREAMS_FREQUENCIES], ["daily", "3d", "7d", "15d", "off"]);
});

test("cada frecuencia tiene opción de UI con etiqueta; «off» se muestra como Apagado", () => {
  assert.deepEqual(
    DREAMS_FREQUENCY_OPTIONS.map((o) => o.value),
    [...DREAMS_FREQUENCIES],
  );
  assert.equal(DREAMS_FREQUENCY_OPTIONS.find((o) => o.value === "off")?.label, "Apagado");
  for (const o of DREAMS_FREQUENCY_OPTIONS) assert.ok(o.label && o.hint);
});

test("reactivar Dreams (off → otra) registra el momento: dreams-run no analiza el período apagado", () => {
  const now = "2026-10-19T12:00:00.000Z";
  assert.deepEqual(frequencyChangeValues("off", "daily", now), { DREAMS_FREQUENCY: "daily", DREAMS_RESUMED_AT: now });
  assert.deepEqual(frequencyChangeValues("off", "7d", now), { DREAMS_FREQUENCY: "7d", DREAMS_RESUMED_AT: now });
  // Sin pasar por «off» no hay reactivación.
  assert.deepEqual(frequencyChangeValues("daily", "7d", now), { DREAMS_FREQUENCY: "7d" });
  assert.deepEqual(frequencyChangeValues(undefined, "daily", now), { DREAMS_FREQUENCY: "daily" });
  assert.deepEqual(frequencyChangeValues("daily", "off", now), { DREAMS_FREQUENCY: "off" });
  assert.deepEqual(frequencyChangeValues("off", "off", now), { DREAMS_FREQUENCY: "off" });
});
