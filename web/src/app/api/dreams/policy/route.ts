import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { setConfigValues } from "@/lib/runtime-config";

const POLICIES = ["all", "error", "none"] as const;

// Política de activación de Dreams (runtime_config DREAMS_AUTO_ACTIVATE):
//   all   → todo aprendizaje se activa al instante (default)
//   error → solo errores se auto-activan; el resto espera aprobación
//   none  → todo espera aprobación manual en /dreams
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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

  await setConfigValues({ DREAMS_AUTO_ACTIVATE: policy }, user.email ?? "dashboard");
  return NextResponse.json({ ok: true, policy });
}
