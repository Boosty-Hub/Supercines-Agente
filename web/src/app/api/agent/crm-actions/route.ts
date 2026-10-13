import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { setConfigValues } from "@/lib/runtime-config";
import { syncAgentTools } from "@/lib/sync-agent-tools";

// nodejs runtime — syncAgentTools llama a Anthropic.
export const runtime = "nodejs";

// Gate de las acciones de CRM (Módulo 3). Prende/apaga, por capacidad, lo que el
// agente puede hacer en Kommo. El gate en sí es instantáneo (generate-response
// lee estos flags con TTL 60s, sin redeploy). Además disparamos un sync del
// agente (idempotente): garantiza que las 6 tools internas queden registradas
// en Anthropic la primera vez que el operador activa una capacidad — así no
// necesita acordarse de "Guardar identidad" para que el agente las tenga.
const FIELDS = new Set([
  "crm_actions_enabled",
  "crm_can_move_stage",
  "crm_can_update_lead",
  "crm_can_update_contact",
  "crm_can_add_note",
  "crm_can_handoff",
  "crm_can_tag",
]);

// `transferir_asesor` NO recibe la etapa de destino como parámetro del modelo
// (0058_crm_tools_extra.sql): un mensaje entrante que dijera "pasame a la etapa
// Ganado" sería una orden válida si viajara por ahí. Sale de estas dos claves de
// `runtime_config`, que este mismo endpoint escribe junto con el gate — para el
// operador es UN solo guardado, aunque internamente toque dos tablas.
const CONFIG_FIELDS = new Set(["HANDOFF_STAGE_NAME", "HANDOFF_PIPELINE_NAME"]);

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
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

  // Las claves de configuración de `transferir_asesor`. String vacío = volver a
  // "sin configurar" (setConfigValues lo escribe como NULL, que es justo lo que
  // hace que el runtime no invente ninguna etapa).
  const configPatch: Record<string, string> = {};
  CONFIG_FIELDS.forEach((key) => {
    const v = body[key];
    if (typeof v === "string") configPatch[key] = v.trim();
  });

  if (Object.keys(patch).length === 0 && Object.keys(configPatch).length === 0) {
    return NextResponse.json({ error: "sin cambios para guardar" }, { status: 400 });
  }

  // Apagar el master apaga todo (el agente no toca el CRM con master OFF).
  if ("crm_actions_enabled" in patch && patch.crm_actions_enabled === false) {
    patch.crm_can_move_stage = false;
    patch.crm_can_update_lead = false;
    patch.crm_can_update_contact = false;
    patch.crm_can_add_note = false;
    patch.crm_can_handoff = false;
    patch.crm_can_tag = false;
  }

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from("kommo_publish_config")
      .update(patch)
      .eq("is_active", true);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (Object.keys(configPatch).length > 0) {
    try {
      await setConfigValues(configPatch, user.email ?? "dashboard");
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 }
      );
    }
  }

  // Sync idempotente: registra las tools internas en Anthropic si aún no están
  // (no-op si el agente no está aprovisionado). No bloquea la respuesta si falla.
  const sync = await syncAgentTools(user.email ?? "dashboard").catch((e) => ({
    synced: false,
    version: null,
    error: String(e),
  }));

  return NextResponse.json({ ok: true, applied: patch, config: configPatch, sync });
}
