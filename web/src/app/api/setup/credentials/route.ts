import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue, setConfigValues } from "@/lib/runtime-config";

export const runtime = "nodejs";

// Step 1 of the wizard: collect identity + the Anthropic API key, validate the
// key against the API, and persist everything to runtime_config. No external
// provisioning happens here — that's the memory/agent/kommo steps.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const anthropicApiKey = str("anthropicApiKey");
  const operatorName = str("operatorName");
  const agentName = str("agentName");
  const agentLabel = str("agentLabel");
  const agentEnvironmentName = str("agentEnvironmentName");
  const agentModel = str("agentModel");
  const masterStoreName = str("masterStoreName");
  const leadsStoreName = str("leadsStoreName");
  const systemPrompt = typeof body.systemPrompt === "string" ? (body.systemPrompt as string) : "";

  // The key is required only if none is configured yet. On a re-run the user
  // can leave it blank to keep the stored key (the wizard hints this). When a
  // new key IS provided we always validate it before persisting.
  const existingKey = await configValue("ANTHROPIC_API_KEY");
  if (!anthropicApiKey && !existingKey) {
    return NextResponse.json(
      { ok: false, error: "ANTHROPIC_API_KEY es obligatoria" },
      { status: 400 }
    );
  }

  if (anthropicApiKey) {
    // Validate the key with a direct, minimal request to the Anthropic API.
    // We deliberately use raw fetch (not the SDK's models.list()) because the
    // SDK's request wrapper returns a spurious "401 (no body)" on some
    // serverless hosts (e.g. Netlify) even for a valid key, while this exact
    // call succeeds. We only HARD-BLOCK on a real auth rejection (401/403 from
    // Anthropic); if Anthropic is simply unreachable, we let the save proceed
    // (the key gets exercised for real when the agent is provisioned).
    try {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: {
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (res.status === 401 || res.status === 403) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        return NextResponse.json(
          {
            ok: false,
            error: `La API key fue rechazada por Anthropic (HTTP ${res.status}). Verificá que sea una key de console.anthropic.com (empieza con sk-ant-) y que el workspace tenga acceso.${detail ? ` Detalle: ${detail}` : ""}`,
          },
          { status: 400 }
        );
      }
      // Any other non-OK (rate limit, 5xx, etc.) is not an auth failure — don't
      // block the user on it; the key is probably fine.
    } catch {
      // Network error reaching Anthropic from the server — don't block.
    }
  }

  // Blank field = "keep existing" (NOT "clear to NULL"). Writing NULL would
  // wipe a stored value and fall back to env — on a partial/blank re-submit
  // that could erase already-set MEMORY_STORE_*_NAME and orphan provisioned
  // IDs. So every field is written only when non-empty.
  try {
    await setConfigValues(
      {
        ...(anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {}),
        ...(operatorName ? { OPERATOR_NAME: operatorName } : {}),
        ...(agentName ? { AGENT_NAME: agentName } : {}),
        ...(agentLabel ? { NEXT_PUBLIC_AGENT_LABEL: agentLabel } : {}),
        ...(agentEnvironmentName ? { AGENT_ENVIRONMENT_NAME: agentEnvironmentName } : {}),
        ...(agentModel ? { AGENT_MODEL: agentModel } : {}),
        ...(masterStoreName ? { MEMORY_STORE_MASTER_NAME: masterStoreName } : {}),
        ...(leadsStoreName ? { MEMORY_STORE_LEADS_NAME: leadsStoreName } : {}),
        ...(systemPrompt ? { SYSTEM_PROMPT: systemPrompt } : {}),
      },
      user.email ?? "setup-wizard"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
