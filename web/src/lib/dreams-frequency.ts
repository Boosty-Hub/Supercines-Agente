// Frecuencias de Dreams (runtime_config.DREAMS_FREQUENCY). Copia de la lista de
// supabase/functions/_shared/dreams-frequency.ts (paridad en supabase/tests/web-parity.test.ts).
// Sin imports de servidor: la usa el selector (client) y la ruta.

export const DREAMS_FREQUENCIES = ["daily", "3d", "7d", "15d", "off"] as const;
export type DreamsFrequency = (typeof DREAMS_FREQUENCIES)[number];

export const DREAMS_FREQUENCY_OPTIONS: { value: DreamsFrequency; label: string; hint: string }[] = [
  { value: "daily", label: "Diario", hint: "El agente aprende todas las noches." },
  { value: "3d", label: "Cada 3 días", hint: "Analiza las conversaciones cada 3 días." },
  { value: "7d", label: "Cada 7 días", hint: "Un análisis semanal de lo aprendido." },
  { value: "15d", label: "Cada 15 días", hint: "Análisis quincenal; menos frecuente." },
  {
    value: "off",
    label: "Apagado",
    hint: "No se analiza nada de forma automática ni se gastan tokens. «Correr ahora» y reconstruir el digest siguen disponibles.",
  },
];

/**
 * Valores a escribir al cambiar la frecuencia. Pasar de «off» a otra registra
 * `DREAMS_RESUMED_AT`: dreams-run no analiza el período apagado (la ventana empieza como mucho
 * `freqDays` antes de la reactivación; dreamsWindowStartMs en _shared/dreams-frequency.ts).
 */
export function frequencyChangeValues(
  prev: string | undefined,
  next: DreamsFrequency,
  nowIso: string,
): { DREAMS_FREQUENCY: DreamsFrequency; DREAMS_RESUMED_AT?: string } {
  if (prev === "off" && next !== "off") return { DREAMS_FREQUENCY: next, DREAMS_RESUMED_AT: nowIso };
  return { DREAMS_FREQUENCY: next };
}
