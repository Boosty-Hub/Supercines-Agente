import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { syncAgentTools } from "@/lib/sync-agent-tools";

// nodejs runtime — syncAgentTools llama a Anthropic.
export const runtime = "nodejs";

// Gate de las acciones de CRM (Módulo 3). Prende/apaga, por capacidad, lo que el
// agente puede hacer en Kommo. El gate en sí es instantáneo (generate-response
// lee estos flags con TTL 60s, sin redeploy). Además disparamos un sync del
// agente (idempotente): garantiza que las 3 tools internas queden registradas
// en Anthropic la primera vez que el operador activa una capacidad — así no
// necesita acordarse de "Guardar identidad" para que el agente las tenga.
const FIELDS = new Set([
  "crm_actions_enabled",
  "crm_can_move_stage",
  "crm_can_update_lead",
  "crm_can_update_contact",
]);

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Acepta { field, value } o un objeto { campo: bool, ... } con varios flags.
  const patch: Record<string, boolean> = {};
  if (typeof body.field === "string" && FIELDS.has(body.field)) {
    patch[body.field] = body.value === true;
  } else {
    for (const [k, v] of Object.entries(body)) {
      if (FIELDS.has(k)) patch[k] = v === true;
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "sin flags válidos para actualizar" }, { status: 400 });
  }

  // Apagar el master apaga todo (el agente no toca el CRM con master OFF).
  if ("crm_actions_enabled" in patch && patch.crm_actions_enabled === false) {
    patch.crm_can_move_stage = false;
    patch.crm_can_update_lead = false;
    patch.crm_can_update_contact = false;
  }

  const { error } = await supabase
    .from("kommo_publish_config")
    .update(patch)
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Sync idempotente: registra las tools internas en Anthropic si aún no están
  // (no-op si el agente no está aprovisionado). No bloquea la respuesta si falla.
  const sync = await syncAgentTools(user.email ?? "dashboard").catch((e) => ({
    synced: false,
    version: null,
    error: String(e),
  }));

  return NextResponse.json({ ok: true, applied: patch, sync });
}
