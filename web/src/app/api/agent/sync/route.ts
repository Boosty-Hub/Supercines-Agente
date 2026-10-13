import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { syncAgentTools } from "@/lib/sync-agent-tools";

export const runtime = "nodejs";

// POST /api/agent/sync — re-empuja el system prompt (SYSTEM_PROMPT del operador +
// CORE_SCAFFOLD vigente) y las tools al Managed Agent. NO modifica SYSTEM_PROMPT.
// Alcance configuracion (prefijo /api/agent en lib/auth/roles.ts).
export async function POST() {
  const authClient = createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const res = await syncAgentTools(user.email ?? "agent-sync");
  if (!res.synced) {
    return NextResponse.json({ ok: false, error: res.error ?? "No hay agente aprovisionado" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, version: res.version });
}
