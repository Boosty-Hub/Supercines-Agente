import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAgentPromptConflict, syncAgentTools, type ConflictResolution } from "@/lib/sync-agent-tools";

export const runtime = "nodejs";

// Alcance configuracion (prefijo /api/agent en lib/auth/roles.ts).
//
// POST /api/agent/sync — re-empuja el system prompt (SYSTEM_PROMPT del operador +
// CORE_SCAFFOLD vigente) y las tools al Managed Agent. NO modifica SYSTEM_PROMPT.
//
// SINCRONIZACIÓN SEGURA: antes de empujar compara el prompt VIVO contra lo último
// sincronizado (lib/agent-prompt-sync.ts). Si fue editado fuera del dashboard (o es la
// primera vez y difiere) NO sincroniza: responde 409 con el conflicto y el diff.
// El usuario decide con `{ "resolve": "overwrite" | "import_live" }`:
//   - overwrite:   empuja el prompt de la DB igual (pisa lo de afuera);
//   - import_live: no empuja; trae el prompt vivo del operador a la DB, restituyendo los
//                  placeholders conocidos (los valores ambiguos se informan y no se tocan).
export async function POST(request: Request) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let resolve: ConflictResolution | undefined;
  try {
    const body = await request.json();
    if (body?.resolve === "overwrite" || body?.resolve === "import_live") resolve = body.resolve;
  } catch {
    // sin cuerpo = sincronización normal
  }

  const res = await syncAgentTools(user.email ?? "agent-sync", { resolve });
  if (res.conflict) {
    return NextResponse.json({ ok: false, error: res.error, conflict: res.conflict }, { status: 409 });
  }
  if (!res.synced) {
    return NextResponse.json({ ok: false, error: res.error ?? "No hay agente aprovisionado" }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    version: res.version,
    imported: res.imported === true,
    placeholders: res.placeholders ?? null,
  });
}

// GET /api/agent/sync — ¿hay un conflicto de prompt pendiente? (sin modificar nada)
export async function GET() {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, conflict: await checkAgentPromptConflict() });
}
