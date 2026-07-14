import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValues, setConfigValues } from "@/lib/runtime-config";
import { syncAgentTools } from "@/lib/sync-agent-tools";
import { renameResource } from "@/lib/anthropic-managed";

// nodejs runtime + raw fetch (lib/anthropic-managed) — the official SDK 401s on
// Netlify. The /agent "Guardar y sincronizar" pushes the prompt via this route.
export const runtime = "nodejs";

// GET — returns the current agent identity (system prompt + display names) so
// the editor page can prefill. Reads DB-first / env-fallback.
export async function GET() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cfg = await configValues([
    "SYSTEM_PROMPT",
    "OPERATOR_NAME",
    "AGENT_NAME",
    "NEXT_PUBLIC_AGENT_LABEL",
    "ANTHROPIC_AGENT_ID",
    "ANTHROPIC_AGENT_VERSION",
  ]);

  return NextResponse.json({
    systemPrompt: cfg.SYSTEM_PROMPT ?? "",
    operatorName: cfg.OPERATOR_NAME ?? "",
    agentName: cfg.AGENT_NAME ?? "",
    agentLabel: cfg.NEXT_PUBLIC_AGENT_LABEL ?? "",
    agentProvisioned: Boolean(cfg.ANTHROPIC_AGENT_ID),
    agentVersion: cfg.ANTHROPIC_AGENT_VERSION ?? null,
  });
}

// POST — persists the identity to runtime_config and, if the agent is already
// provisioned (ANTHROPIC_AGENT_ID present), pushes the new system prompt +
// tools to Anthropic via syncAgentTools (reads enabled tools from DB, builds
// the full tool surface, calls updateAgent with optimistic concurrency retry).
//
// If the agent is NOT yet provisioned, the prompt is still saved to the DB so
// the /setup wizard (Phase 3) can create the agent from it. We never block the
// save on Anthropic — identity persistence and remote sync are independent.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await request.formData();
  const systemPrompt = form.get("system_prompt")?.toString() ?? "";
  const operatorName = form.get("operator_name")?.toString().trim() ?? "";
  let agentName = form.get("agent_name")?.toString().trim() ?? "";
  const agentLabel = form.get("agent_label")?.toString().trim() ?? "";

  // 0. Si el nombre del agente cambió y ya está aprovisionado, renombrarlo en
  //    Anthropic ANTES de persistir. El wizard /setup resuelve por nombre
  //    (findByName): si la DB y Anthropic divergen, un re-run del setup crearía
  //    un agente DUPLICADO. Config y Anthropic se mueven juntos o no se mueven.
  let renameError: string | null = null;
  const current = await configValues(["AGENT_NAME", "ANTHROPIC_AGENT_ID", "ANTHROPIC_API_KEY"]);
  const nameChanged =
    agentName !== "" && (current.AGENT_NAME ?? "") !== "" && agentName !== current.AGENT_NAME;
  if (nameChanged && current.ANTHROPIC_AGENT_ID && current.ANTHROPIC_API_KEY) {
    try {
      await renameResource(current.ANTHROPIC_API_KEY, "agents", current.ANTHROPIC_AGENT_ID, agentName);
    } catch (err) {
      // El rename falló → NO persistir el nombre nuevo (quedaría inconsistente).
      // El resto de la identidad se guarda igual.
      renameError = err instanceof Error ? err.message : String(err);
      agentName = current.AGENT_NAME!;
    }
  }

  // 1. Persist identity to runtime_config (single source of truth).
  try {
    await setConfigValues(
      {
        SYSTEM_PROMPT: systemPrompt,
        OPERATOR_NAME: operatorName,
        AGENT_NAME: agentName,
        NEXT_PUBLIC_AGENT_LABEL: agentLabel,
      },
      user.email ?? "dashboard"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(
      new URL(`/agent?error=${encodeURIComponent(msg)}`, request.url),
      { status: 303 }
    );
  }

  // 2. Sync tools + system prompt to Anthropic if the agent already exists.
  //    SIEMPRE corre, incluso si el rename falló — la persistencia de identidad
  //    y el sync del prompt son independientes; un rename fallido no debe dejar
  //    los cambios de prompt sin sincronizar.
  const sync = await syncAgentTools(user.email ?? "dashboard");

  if (renameError) {
    const detail = sync.synced
      ? `Prompt sincronizado, pero NO se pudo renombrar el agente en Anthropic (se mantuvo "${current.AGENT_NAME}"): ${renameError}`
      : `No se pudo renombrar el agente (se mantuvo "${current.AGENT_NAME}"): ${renameError}`;
    return NextResponse.redirect(
      new URL(`/agent?saved=1&sync=error&error=${encodeURIComponent(detail)}`, request.url),
      { status: 303 }
    );
  }

  if (!sync.synced && sync.error) {
    return NextResponse.redirect(
      new URL(
        `/agent?saved=1&sync=error&error=${encodeURIComponent(sync.error)}`,
        request.url
      ),
      { status: 303 }
    );
  }

  if (!sync.synced) {
    // Saved to DB but not provisioned yet — the wizard will create the agent.
    return NextResponse.redirect(
      new URL("/agent?saved=1&sync=pending", request.url),
      { status: 303 }
    );
  }

  return NextResponse.redirect(new URL("/agent?saved=1&sync=ok", request.url), {
    status: 303,
  });
}
