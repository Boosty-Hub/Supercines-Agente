import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValues, setConfigValues } from "@/lib/runtime-config";
import { retrieveAgent, updateAgent } from "@/lib/anthropic-managed";
import { checkAgentPromptConflict } from "@/lib/sync-agent-tools";
import { ALLOWED_MODELS, MODEL_KEYS } from "@/lib/model-config";
import { agentModelMatches, agentModelParam } from "@/lib/model-capabilities";

export const runtime = "nodejs";

// POST /api/usage/models — actualiza los modelos por componente.
// AGENT_MODEL además actualiza el Managed Agent en Anthropic (es el modelo
// real de las sesiones CMA); si esa actualización falla, NO se persiste la
// key para que config y agente no diverjan.
export async function POST(request: Request) {
  const authClient = await createSupabaseServerClient();
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
    const cfg = await configValues(["ANTHROPIC_API_KEY", "ANTHROPIC_AGENT_ID"]);
    if (cfg.ANTHROPIC_API_KEY && cfg.ANTHROPIC_AGENT_ID) {
      // Cambiar el modelo SUBE la versión del agente: si el prompt vivo fue editado
      // fuera del dashboard, esa versión nueva taparía la señal de conflicto. No se
      // toca el agente hasta que el usuario lo resuelva en la página Agente.
      // `onlyWithBaseline`: este camino NO empuja el prompt, así que un cliente sin hash
      // registrado (recién actualizado, primera sincronización pendiente) no tiene señal que
      // tapar y NO se bloquea: solo frena una edición externa respecto de una línea base real.
      const conflict = await checkAgentPromptConflict(undefined, { onlyWithBaseline: true });
      if (conflict) {
        return NextResponse.json(
          {
            ok: false,
            error: "El prompt del agente fue modificado fuera del dashboard: resolvelo en la página Agente antes de cambiar el modelo.",
            conflict,
          },
          { status: 409 }
        );
      }
      try {
        const desired = agentModelParam(updates.AGENT_MODEL);
        const doUpdate = async () => {
          const current = await retrieveAgent(cfg.ANTHROPIC_API_KEY!, cfg.ANTHROPIC_AGENT_ID!);
          // Se compara contra el AGENTE VIVO (no contra runtime_config): si la
          // key de config está vacía o desfasada, igual se converge al modelo
          // pedido en vez de dar por hecho un cambio que nunca llegó a Anthropic.
          if (agentModelMatches(current.model, desired)) return (current.version as number) ?? 0;
          const updated = await updateAgent(cfg.ANTHROPIC_API_KEY!, cfg.ANTHROPIC_AGENT_ID!, {
            version: current.version,
            model: desired,
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
