import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { setConfigValues } from "@/lib/runtime-config";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const FREQUENCIES = ["daily", "3d", "7d", "15d"] as const;
const FrequencyBody = z.object({ frequency: z.enum(FREQUENCIES) });

// Frecuencia del análisis nocturno de Dreams (runtime_config DREAMS_FREQUENCY):
//   daily → todos los días · 3d → cada 3 días · 7d → cada 7 · 15d → cada 15.
// El cron sigue disparando a diario; dreams-run hace un due-check y saltea si
// todavía no toca (según DREAMS_LAST_RUN).
export async function POST(request: Request) {
  const auth = await requireScope("contenido");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, FrequencyBody);
  if (!input.ok) return input.response;
  const { frequency } = input.data;

  await setConfigValues({ DREAMS_FREQUENCY: frequency }, auth.writer);
  return NextResponse.json({ ok: true, frequency });
}
