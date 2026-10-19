import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { configValuesFresh, setConfigValues } from "@/lib/runtime-config";
import { z } from "zod";
import { readJson } from "@/lib/api/body";
import { DREAMS_FREQUENCIES, frequencyChangeValues } from "@/lib/dreams-frequency";

const FrequencyBody = z.object({ frequency: z.enum(DREAMS_FREQUENCIES) });

// Frecuencia del análisis nocturno de Dreams (runtime_config DREAMS_FREQUENCY):
//   daily → todos los días · 3d → cada 3 días · 7d → cada 7 · 15d → cada 15 ·
//   off → apagado (el cron no analiza; «Correr ahora» y el digest siguen funcionando).
// El cron sigue disparando a diario; dreams-run hace un due-check y saltea si
// todavía no toca (según DREAMS_LAST_RUN). Pasar de off a otra frecuencia registra
// DREAMS_RESUMED_AT: la primera corrida tras reactivar no analiza el período apagado.
export async function POST(request: Request) {
  const auth = await requireScope("contenido");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, FrequencyBody);
  if (!input.ok) return input.response;
  const { frequency } = input.data;

  const { DREAMS_FREQUENCY: prev } = await configValuesFresh(["DREAMS_FREQUENCY"] as const);
  await setConfigValues(frequencyChangeValues(prev, frequency, new Date().toISOString()), auth.writer);
  return NextResponse.json({ ok: true, frequency });
}
