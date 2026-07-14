import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { configValues, setConfigValues } from "@/lib/runtime-config";
import {
  buildAgentTools,
  composeSystem,
  type AgentToolRow,
} from "@/lib/agent-prompt";
import { syncAgentTools } from "@/lib/sync-agent-tools";
import {
  findByName,
  retrieveResource,
  renameResource,
  createEnvironment,
  createAgent,
} from "@/lib/anthropic-managed";

// nodejs runtime. NOTE: we use raw fetch (lib/anthropic-managed) instead of the
// official @anthropic-ai/sdk because the SDK returns a spurious "401 (no body)"
// on Netlify's serverless runtime even for a valid key.
export const runtime = "nodejs";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_DESCRIPTION =
  "Responde mensajes entrantes de leads con la voz definida en el system prompt.";
const ENV_DESCRIPTION =
  "Environment estándar para el agente. Networking sin restricciones (las llamadas autenticadas se hacen vía custom tools del orchestrator, no desde el container).";

// Helper: fetch all enabled tool rows for the initial agent create call.
async function fetchEnabledToolRows(): Promise<AgentToolRow[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("agent_tools")
    .select("name, description, input_schema")
    .eq("enabled", true)
    .order("tool_type", { ascending: false })  // 'system' > 'http'
    .order("created_at", { ascending: true });
  return (data ?? []) as AgentToolRow[];
}

// Step 3: create/reconcile the Anthropic Environment + Managed Agent. Idempotent
// — finds existing resources by name (reuses + updates) and creates missing ones.
export async function POST() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const cfg = await configValues([
    "ANTHROPIC_API_KEY",
    "AGENT_NAME",
    "AGENT_ENVIRONMENT_NAME",
    "AGENT_MODEL",
    "AGENT_DESCRIPTION",
    "OPERATOR_NAME",
    "MEMORY_STORE_MASTER_NAME",
    "MEMORY_STORE_LEADS_NAME",
    "SYSTEM_PROMPT",
    "ANTHROPIC_AGENT_ID",
    "ANTHROPIC_ENVIRONMENT_ID",
  ]);

  const apiKey = cfg.ANTHROPIC_API_KEY;
  const agentName = cfg.AGENT_NAME?.trim();
  const envName = cfg.AGENT_ENVIRONMENT_NAME?.trim();
  const systemPromptRaw = cfg.SYSTEM_PROMPT;

  const missing: string[] = [];
  if (!apiKey) missing.push("ANTHROPIC_API_KEY");
  if (!agentName) missing.push("AGENT_NAME");
  if (!envName) missing.push("AGENT_ENVIRONMENT_NAME");
  if (!systemPromptRaw) missing.push("SYSTEM_PROMPT (editalo en /agent)");
  if (missing.length) {
    return NextResponse.json(
      { ok: false, error: `Faltan: ${missing.join(", ")}` },
      { status: 400 }
    );
  }

  // Fetch enabled tool rows from DB (system + http) for the initial tool surface.
  const toolRows = await fetchEnabledToolRows();
  const httpRows = toolRows.filter((r) => r.name !== "agent_toolset_20260401");
  const tools = buildAgentTools(toolRows);

  // composeSystem = operator's editable prompt + the fixed CORE_SCAFFOLD
  // (machinery + security), with placeholders substituted. Same composition the
  // sync path uses, so the agent always gets the contract.
  const system = composeSystem(
    systemPromptRaw!,
    {
      operatorName: cfg.OPERATOR_NAME || "el operador",
      masterStoreName: cfg.MEMORY_STORE_MASTER_NAME || "master",
      leadsStoreName: cfg.MEMORY_STORE_LEADS_NAME || "leads",
    },
    httpRows
  );

  try {
    const key = apiKey!;

    // 1. Environment — ID-first (el ID en runtime_config es la verdad; el
    //    nombre puede haber cambiado). Reconcilia el nombre remoto al de la
    //    config. Fallback: por nombre, y si no existe, crear.
    let envId: string;
    let envCreated = false;
    const envById = cfg.ANTHROPIC_ENVIRONMENT_ID
      ? await retrieveResource(key, "environments", cfg.ANTHROPIC_ENVIRONMENT_ID)
      : null;
    if (envById) {
      envId = envById.id;
      if (envById.name !== envName) {
        await renameResource(key, "environments", envId, envName!);
      }
    } else {
      const existingEnv = await findByName(key, "environments", envName!);
      if (existingEnv) {
        envId = existingEnv.id;
      } else {
        const env = await createEnvironment(key, {
          name: envName,
          description: ENV_DESCRIPTION,
          config: { type: "cloud", networking: { type: "unrestricted" } },
        });
        envId = env.id;
        envCreated = true;
      }
    }

    // 2. Agent — ID-first (mismo principio: nunca crear un duplicado porque el
    //    nombre drifteó). Reconcilia nombre remoto → config antes del sync.
    let agentId: string;
    let agentVersion: number;
    let agentCreated = false;
    const agentById = cfg.ANTHROPIC_AGENT_ID
      ? await retrieveResource(key, "agents", cfg.ANTHROPIC_AGENT_ID)
      : null;
    const existingAgent = agentById ?? (await findByName(key, "agents", agentName!));
    if (existingAgent) {
      if (existingAgent.name !== agentName) {
        await renameResource(key, "agents", existingAgent.id, agentName!);
      }
      // Agent exists — use syncAgentTools for the update path (it handles
      // optimistic concurrency retry and persists the new version).
      const sync = await syncAgentTools(user.email ?? "setup-wizard");
      agentId = existingAgent.id;
      agentVersion = sync.version ?? existingAgent.version ?? 0;
    } else {
      // Agent does not exist yet — create it with the current tool surface.
      const created = await createAgent(key, {
        name: agentName,
        model: cfg.AGENT_MODEL || DEFAULT_MODEL,
        description: cfg.AGENT_DESCRIPTION || DEFAULT_DESCRIPTION,
        system,
        tools,
      });
      agentId = created.id;
      agentVersion = (created.version as number) ?? 0;
      agentCreated = true;
    }

    await setConfigValues(
      {
        ANTHROPIC_ENVIRONMENT_ID: envId,
        ANTHROPIC_AGENT_ID: agentId,
        ANTHROPIC_AGENT_VERSION: String(agentVersion),
      },
      user.email ?? "setup-wizard"
    );

    return NextResponse.json({
      ok: true,
      environment: { id: envId, created: envCreated },
      agent: { id: agentId, version: agentVersion, created: agentCreated },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
