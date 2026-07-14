import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValues, setConfigValues } from "@/lib/runtime-config";
import {
  findByName,
  createMemoryStore,
  retrieveResource,
  renameResource,
} from "@/lib/anthropic-managed";

// nodejs runtime. Uses raw fetch (lib/anthropic-managed) instead of the official
// @anthropic-ai/sdk, which returns a spurious "401 (no body)" on Netlify.
export const runtime = "nodejs";

// Descriptions kept identical to scripts/setup-memory-stores.mjs so the agent's
// in-container filesystem guidance is the same whether provisioned from CLI or
// the wizard.
const MASTER_DESCRIPTION =
  "Memoria global del operador: voz (reglas, chats reales, transcripciones, respuestas ejemplares), KB destilada y aprendizajes destilados por el job de Dreams. " +
  "Estructura del filesystem: /voice/rule/<sample_id>_<chunk>.md, /voice/chat_export/<id>_<chunk>.md, /voice/transcript/<id>_<chunk>.md, /voice/example_response/<id>_<chunk>.md, /kb/<doc>/<chunk>.md, /dreams/<date>_<topic>.md. " +
  "ANTES de redactar cualquier respuesta a un lead: grep por palabras clave del mensaje del lead en /voice/ para reglas y ejemplos aplicables; consultá /kb/ para info factual; mirá /dreams/ para aprendizajes recientes que tienen prioridad sobre la voz base.";

const LEADS_DESCRIPTION =
  "Memoria persistente por lead. Estructura: /<lead_id>/conversation.md (timeline de mensajes inbound/outbound), /<lead_id>/learnings.md (observaciones del agente: objeciones recurrentes, contexto, preferencias, vertical asignada). " +
  "El lead_id es el ID nativo del lead en el CRM. ANTES de responder a un mensaje entrante: leer /<lead_id>/conversation.md y /<lead_id>/learnings.md si existen, para contexto histórico. DESPUÉS de responder: actualizar conversation.md con el nuevo turno y agregar a learnings.md si aprendiste algo nuevo sobre el lead.";

// Step 2: create/reconcile the two Memory Stores. Idempotent — finds existing
// stores by name (reuses their IDs) and only creates the missing ones.
export async function POST() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const cfg = await configValues([
    "ANTHROPIC_API_KEY",
    "MEMORY_STORE_MASTER_NAME",
    "MEMORY_STORE_LEADS_NAME",
    "ANTHROPIC_MEMORY_MASTER_ID",
    "ANTHROPIC_MEMORY_LEADS_ID",
  ]);

  if (!cfg.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { ok: false, error: "Falta ANTHROPIC_API_KEY — completá el paso de credenciales primero" },
      { status: 400 }
    );
  }
  const masterName = cfg.MEMORY_STORE_MASTER_NAME?.trim();
  const leadsName = cfg.MEMORY_STORE_LEADS_NAME?.trim();
  if (!masterName || !leadsName) {
    return NextResponse.json(
      { ok: false, error: "Faltan los nombres de los Memory Stores (master / leads)" },
      { status: 400 }
    );
  }

  try {
    const key = cfg.ANTHROPIC_API_KEY!;

    // ID-first: si ya tenemos el ID en runtime_config, ese store ES el nuestro
    // (los datos viven ahí) aunque el nombre haya cambiado. Reconciliamos el
    // nombre remoto al de la config — el nombre es también la ruta de montaje
    // (/mnt/memory/<name>) que usa el system prompt, así que la config manda.
    const ensure = async (name: string, description: string, knownId?: string) => {
      const byId = knownId ? await retrieveResource(key, "memory_stores", knownId) : null;
      if (byId) {
        if (byId.name !== name) {
          await renameResource(key, "memory_stores", byId.id, name);
        }
        return { id: byId.id, created: false };
      }
      const existing = await findByName(key, "memory_stores", name);
      if (existing) return { id: existing.id, created: false };
      const created = await createMemoryStore(key, { name, description });
      return { id: created.id, created: true };
    };

    const master = await ensure(masterName, MASTER_DESCRIPTION, cfg.ANTHROPIC_MEMORY_MASTER_ID);
    const leads = await ensure(leadsName, LEADS_DESCRIPTION, cfg.ANTHROPIC_MEMORY_LEADS_ID);

    await setConfigValues(
      {
        ANTHROPIC_MEMORY_MASTER_ID: master.id,
        ANTHROPIC_MEMORY_LEADS_ID: leads.id,
      },
      user.email ?? "setup-wizard"
    );

    return NextResponse.json({
      ok: true,
      master: { id: master.id, created: master.created },
      leads: { id: leads.id, created: leads.created },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
