import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { DREAMS_FREQUENCIES, DREAMS_FREQ_DAYS, dreamsGate, dreamsWindowStartMs, isDreamsOff } from "./dreams-frequency.ts";

Deno.test("frecuencias permitidas: apagado incluido; los días salen de una sola tabla", () => {
  assertEquals([...DREAMS_FREQUENCIES], ["daily", "3d", "7d", "15d", "off"]);
  assertEquals(DREAMS_FREQ_DAYS, { daily: 1, "3d": 3, "7d": 7, "15d": 15 });
});

Deno.test("isDreamsOff: solo el valor exacto «off»", () => {
  assertEquals(isDreamsOff("off"), true);
  for (const v of ["daily", "3d", "", undefined, null, "OFF", " off", "0", "false"]) {
    assertEquals(isDreamsOff(v as string | undefined), false);
  }
});

Deno.test("dreamsGate: apagado + corrida del cron (daily o weekly) = omitida sin llamar al modelo", () => {
  for (const period of ["daily", "weekly"] as const) {
    assertEquals(dreamsGate({ frequency: "off", force: false, digestOnly: false, period }), {
      skip: true,
      reason: "disabled",
    });
  }
});

Deno.test("dreamsGate: apagado + corrida manual (force) o digest_only SÍ corren", () => {
  for (const period of ["daily", "weekly"] as const) {
    assertEquals(dreamsGate({ frequency: "off", force: true, digestOnly: false, period }), { skip: false });
    assertEquals(dreamsGate({ frequency: "off", force: false, digestOnly: true, period }), { skip: false });
  }
});

Deno.test("dreamsGate: encendido o sin configurar nunca omite", () => {
  for (const frequency of ["daily", "3d", "7d", "15d", "", undefined, "raro"]) {
    assertEquals(dreamsGate({ frequency, force: false, digestOnly: false, period: "weekly" }), { skip: false });
  }
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-19T03:00:00Z");

Deno.test("dreamsWindowStartMs: sin reactivación = hueco desde la última corrida (1..30 días)", () => {
  assertEquals(dreamsWindowStartMs({ nowMs: NOW, lastRunMs: NOW - 3 * DAY, freqDays: 3, resumedAtMs: NaN }), NOW - 3 * DAY);
  assertEquals(dreamsWindowStartMs({ nowMs: NOW, lastRunMs: NOW - 3600_000, freqDays: 1, resumedAtMs: NaN }), NOW - DAY);
  assertEquals(dreamsWindowStartMs({ nowMs: NOW, lastRunMs: NOW - 90 * DAY, freqDays: 1, resumedAtMs: NaN }), NOW - 30 * DAY);
  // Primera corrida: freqDays.
  assertEquals(dreamsWindowStartMs({ nowMs: NOW, lastRunMs: NaN, freqDays: 7, resumedAtMs: NaN }), NOW - 7 * DAY);
});

Deno.test("dreamsWindowStartMs: tras reactivar NO se analiza el período apagado (como mucho freqDays antes de reactivar)", () => {
  // Apagado 40 días, reactivado hace 1 h, diario: solo el día previo a la reactivación en adelante.
  const resumed = NOW - 3600_000;
  assertEquals(dreamsWindowStartMs({ nowMs: NOW, lastRunMs: NOW - 40 * DAY, freqDays: 1, resumedAtMs: resumed }), resumed - DAY);
  assertEquals(dreamsWindowStartMs({ nowMs: NOW, lastRunMs: NOW - 40 * DAY, freqDays: 7, resumedAtMs: resumed }), resumed - 7 * DAY);
  // Sin corrida previa, igual.
  assertEquals(dreamsWindowStartMs({ nowMs: NOW, lastRunMs: NaN, freqDays: 15, resumedAtMs: resumed }), NOW - 15 * DAY);
  assertEquals(dreamsWindowStartMs({ nowMs: NOW, lastRunMs: NaN, freqDays: 3, resumedAtMs: NOW - 20 * DAY }), NOW - 3 * DAY);
  // Una corrida posterior a la reactivación manda (la reactivación ya quedó atrás).
  assertEquals(dreamsWindowStartMs({ nowMs: NOW, lastRunMs: NOW - 2 * DAY, freqDays: 1, resumedAtMs: NOW - 10 * DAY }), NOW - 2 * DAY);
});
