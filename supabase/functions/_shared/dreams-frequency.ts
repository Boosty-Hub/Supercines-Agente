// _shared/dreams-frequency.ts
// Valores de runtime_config.DREAMS_FREQUENCY y la compuerta de «Dreams apagado». Copia de la
// lista en web/src/lib/dreams-frequency.ts (paridad: supabase/tests/web-parity.test.ts).
//
// `off` apaga las corridas AUTOMÁTICAS (cron daily y weekly): vuelven `{skipped, reason:
// "disabled"}` sin llamar al modelo. Lo MANUAL sigue funcionando: `force` (botón «Correr
// ahora») y `digest_only` (reconstruir o vaciar el digest, aunque el operador haya apagado
// Dreams). Antes la única forma de apagarlo era borrar los cron jobs a mano.

export const DREAMS_FREQUENCIES = ["daily", "3d", "7d", "15d", "off"] as const;
export type DreamsFrequency = typeof DREAMS_FREQUENCIES[number];

/** Días entre corridas del run `daily` según la frecuencia (off no tiene). */
export const DREAMS_FREQ_DAYS: Record<string, number> = { daily: 1, "3d": 3, "7d": 7, "15d": 15 };

export function isDreamsOff(frequency: string | null | undefined): boolean {
  return frequency === "off";
}

export function dreamsGate(args: {
  frequency: string | null | undefined;
  force: boolean;
  digestOnly: boolean;
  period: "daily" | "weekly";
}): { skip: false } | { skip: true; reason: "disabled" } {
  if (isDreamsOff(args.frequency) && !args.force && !args.digestOnly) return { skip: true, reason: "disabled" };
  return { skip: false };
}

const DAY_MS = 86_400_000;

/**
 * Inicio de la ventana del run `daily`. Sin reactivación: el hueco real desde la última corrida
 * (clamp 1..30 días; freqDays si es la primera), para que 3d/7d/15d no pierdan días.
 * Con `DREAMS_RESUMED_AT` (lo registra /api/dreams/frequency al pasar de «off» a otra
 * frecuencia) posterior a la última corrida: nunca más de `freqDays` antes de la reactivación.
 * Sin eso, reactivar tras un mes apagado analizaba de golpe los 30 días del período apagado.
 */
export function dreamsWindowStartMs(args: {
  nowMs: number;
  lastRunMs: number;
  freqDays: number;
  resumedAtMs: number;
}): number {
  const { nowMs, lastRunMs, freqDays, resumedAtMs } = args;
  const spanMs = Number.isFinite(lastRunMs)
    ? Math.min(Math.max(nowMs - lastRunMs, DAY_MS), 30 * DAY_MS)
    : Math.min(freqDays * DAY_MS, 30 * DAY_MS);
  const base = nowMs - spanMs;
  const resumedAfterLastRun =
    Number.isFinite(resumedAtMs) && (!Number.isFinite(lastRunMs) || resumedAtMs > lastRunMs);
  if (!resumedAfterLastRun) return base;
  return Math.max(base, resumedAtMs - freqDays * DAY_MS);
}
