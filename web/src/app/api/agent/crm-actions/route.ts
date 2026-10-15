import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { setConfigValues } from "@/lib/runtime-config";
import { syncAgentTools } from "@/lib/sync-agent-tools";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// Acepta { field, value } o un objeto { campo: bool, ... } con varios flags (+ claves de handoff).
const CrmActionsBody = z.object({
  field: z.string().optional(),
  value: z.boolean().optional(),
  crm_actions_enabled: z.boolean().optional(),
  crm_can_move_stage: z.boolean().optional(),
  crm_can_update_lead: z.boolean().optional(),
  crm_can_update_contact: z.boolean().optional(),
  crm_can_add_note: z.boolean().optional(),
  crm_can_handoff: z.boolean().optional(),
  crm_can_tag: z.boolean().optional(),
  HANDOFF_STAGE_NAME: z.string().optional(),
  HANDOFF_PIPELINE_NAME: z.string().optional(),
});

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
// (0067_crm_tools_extra.sql): un mensaje entrante que dijera "pasame a la etapa
// Ganado" sería una orden válida si viajara por ahí. Sale de estas dos claves de
// `runtime_config`, que este mismo endpoint escribe junto con el gate — para el
// operador es UN solo guardado, aunque internamente toque dos tablas.
const CONFIG_FIELDS = new Set(["HANDOFF_STAGE_NAME", "HANDOFF_PIPELINE_NAME"]);

export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const input = await readJson(request, CrmActionsBody);
  if (!input.ok) return input.response;
  const body = input.data;

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
    const v = body[key as "HANDOFF_STAGE_NAME" | "HANDOFF_PIPELINE_NAME"];
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
      await setConfigValues(configPatch, auth.writer);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 }
      );
    }
  }

  // Sync idempotente: registra las tools internas en Anthropic si aún no están
  // (no-op si el agente no está aprovisionado). No bloquea la respuesta si falla.
  const sync = await syncAgentTools(auth.writer).catch((e) => ({
    synced: false,
    version: null,
    error: String(e),
  }));

  return NextResponse.json({ ok: true, applied: patch, config: configPatch, sync });
}
