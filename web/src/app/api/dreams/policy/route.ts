import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { setConfigValues } from "@/lib/runtime-config";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const POLICIES = ["all", "error", "none"] as const;
const PolicyBody = z.object({ policy: z.enum(POLICIES) });

// Política de activación de Dreams (runtime_config DREAMS_AUTO_ACTIVATE):
//   all   → todo aprendizaje se activa al instante (default)
//   error → solo errores se auto-activan; el resto espera aprobación
//   none  → todo espera aprobación manual en /dreams
export async function POST(request: Request) {
  const auth = await requireScope("contenido");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, PolicyBody);
  if (!input.ok) return input.response;
  const { policy } = input.data;

  await setConfigValues({ DREAMS_AUTO_ACTIVATE: policy }, auth.writer);
  return NextResponse.json({ ok: true, policy });
}
