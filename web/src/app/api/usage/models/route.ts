import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValues, setConfigValues } from "@/lib/runtime-config";
import { retrieveAgent, updateAgent } from "@/lib/anthropic-managed";
import { ALLOWED_MODELS, MODEL_KEYS } from "@/lib/model-config";

export const runtime = "nodejs";

// POST /api/usage/models — actualiza los modelos por componente.
// AGENT_MODEL además actualiza el Managed Agent en Anthropic (es el modelo
// real de las sesiones CMA); si esa actualización falla, NO se persiste la
// key para que config y agente no diverjan.
export async function POST(request: Request) {
  const authClient = createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const updates: Record<string, string> = {};
  for (const key of Object.keys(MODEL_KEYS)) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !(ALLOWED_MODELS as readonly string[]).includes(v)) {
      return NextResponse.json({ ok: false, error: `Modelo inválido para ${key}` }, { status: 400 });
    }
    updates[key] = v;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: false, error: "Nada para actualizar" }, { status: 400 });
  }

  const actor = user.email ?? "consumo-models";
  let agentVersion: number | null = null;

  // AGENT_MODEL: sincronizar primero con Anthropic (el agente manda).
  if (updates.AGENT_MODEL) {
    const cfg = await configValues(["ANTHROPIC_API_KEY", "ANTHROPIC_AGENT_ID", "AGENT_MODEL"]);
    const currentModel = cfg.AGENT_MODEL || MODEL_KEYS.AGENT_MODEL;
    if (updates.AGENT_MODEL !== currentModel && cfg.ANTHROPIC_API_KEY && cfg.ANTHROPIC_AGENT_ID) {
      try {
        const doUpdate = async () => {
          const current = await retrieveAgent(cfg.ANTHROPIC_API_KEY!, cfg.ANTHROPIC_AGENT_ID!);
          const updated = await updateAgent(cfg.ANTHROPIC_API_KEY!, cfg.ANTHROPIC_AGENT_ID!, {
            version: current.version,
            model: updates.AGENT_MODEL,
          });
          return (updated.version as number) ?? 0;
        };
        try {
          agentVersion = await doUpdate();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/\b409\b|conflict/i.test(msg)) {
            agentVersion = await doUpdate(); // version race: reintentar una vez
          } else {
            throw err;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // No persistir AGENT_MODEL si el agente real no cambió.
        delete updates.AGENT_MODEL;
        if (Object.keys(updates).length === 0) {
          return NextResponse.json({ ok: false, error: `No se pudo actualizar el agente en Anthropic: ${msg}` }, { status: 502 });
        }
      }
    }
  }

  await setConfigValues(
    {
      ...updates,
      ...(agentVersion != null ? { ANTHROPIC_AGENT_VERSION: String(agentVersion) } : {}),
    },
    actor
  );

  return NextResponse.json({ ok: true, updated: Object.keys(updates), agentVersion });
}
