import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { callInternalFunction, INTERNAL_401_HINT } from "@/lib/internal-call";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// Botón «correr ahora» (period opcional; default daily).
const RunBody = z.object({ period: z.enum(["daily", "weekly"]).optional() });

export async function POST(request: Request) {
  const auth = await requireScope("contenido");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, RunBody, { optional: true });
  if (!input.ok) return input.response;
  const period = input.data.period ?? "daily";

  // El botón manual siempre corre YA (force), aunque la frecuencia configurada
  // todavía no toque. El cron (trigger_dreams) manda solo {period} → sujeto al
  // due-check por frecuencia.
  const res = await callInternalFunction("dreams-run", { period, force: true }, { timeoutMs: 120_000 });
  if (res.status === 401) return NextResponse.json({ error: INTERNAL_401_HINT }, { status: 503 });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.ok ? 200 : 500 });
}
