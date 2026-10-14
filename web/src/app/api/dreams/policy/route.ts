import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { setConfigValues } from "@/lib/runtime-config";

const POLICIES = ["all", "error", "none"] as const;

// Política de activación de Dreams (runtime_config DREAMS_AUTO_ACTIVATE):
//   all   → todo aprendizaje se activa al instante (default)
//   error → solo errores se auto-activan; el resto espera aprobación
//   none  → todo espera aprobación manual en /dreams
export async function POST(request: Request) {
  const auth = await requireScope("contenido");
  if (!auth.ok) return auth.response;

  let body: { policy?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const policy = String(body.policy ?? "");
  if (!POLICIES.includes(policy as (typeof POLICIES)[number])) {
    return NextResponse.json(
      { error: `policy debe ser uno de: ${POLICIES.join(", ")}` },
      { status: 400 }
    );
  }

  await setConfigValues({ DREAMS_AUTO_ACTIVATE: policy }, auth.writer);
  return NextResponse.json({ ok: true, policy });
}
