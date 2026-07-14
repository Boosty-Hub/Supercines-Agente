// server-only: shared helper that rebuilds the Managed Agent's tool surface
// and pushes it to Anthropic. Called by every mutation that touches the tool
// registry or the agent identity:
//   - /api/agent (identity save)
//   - /api/setup/agent (create / update during wizard)
//   - /api/tools (create / toggle / delete HTTP tools)
//
// On version mismatch (HTTP 409 / "version" in error message) the helper
// re-reads the current agent version and retries once. On any other failure it
// returns { synced: false, error } without throwing, so the CRUD response that
// triggered the sync is still returned to the client.

import { createServiceClient } from "@/lib/supabase/service";
import { configValues, setConfigValues } from "@/lib/runtime-config";
import {
  buildAgentTools,
  composeSystem,
  type AgentToolRow,
} from "@/lib/agent-prompt";
import { retrieveAgent, updateAgent } from "@/lib/anthropic-managed";

export interface SyncResult {
  version: number | null;
  synced: boolean;
  error?: string;
}

/**
 * Reads all enabled agent_tools rows from the DB, builds the Anthropic tools
 * array, substitutes system-prompt placeholders, and calls updateAgent with
 * optimistic concurrency. Returns the new version on success.
 *
 * @param actor  Email or identifier of the user triggering the sync (for
 *               audit trail in runtime_config.updated_by).
 */
export async function syncAgentTools(actor: string): Promise<SyncResult> {
  // 1. Resolve required config keys.
  const cfg = await configValues([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AGENT_ID",
    "OPERATOR_NAME",
    "MEMORY_STORE_MASTER_NAME",
    "MEMORY_STORE_LEADS_NAME",
    "SYSTEM_PROMPT",
  ]);

  const apiKey = cfg.ANTHROPIC_API_KEY;
  const agentId = cfg.ANTHROPIC_AGENT_ID;

  // If the agent hasn't been provisioned yet, skip silently (the wizard will
  // create it with the correct tool surface later).
  if (!apiKey || !agentId) {
    return { version: null, synced: false };
  }

  try {
    // 2. Fetch all enabled tool rows (system + http) in the order they'll be
    //    rendered: toolset first (system rows ordered by name desc puts
    //    agent_toolset before search_kb), then http rows by created_at.
    const supabase = createServiceClient();
    const { data, error: fetchErr } = await supabase
      .from("agent_tools")
      .select("name, description, input_schema")
      .eq("enabled", true)
      .order("tool_type", { ascending: false })   // 'system' > 'http'
      .order("created_at", { ascending: true });

    if (fetchErr) {
      console.error("syncAgentTools: failed to fetch agent_tools:", fetchErr.message);
      return { version: null, synced: false, error: fetchErr.message };
    }

    const rows = (data ?? []) as AgentToolRow[];

    // 3. Build tools array and substitute system-prompt placeholders.
    const tools = buildAgentTools(rows);
    const httpRows = rows.filter((r) => r.name !== "agent_toolset_20260401");

    // composeSystem prepends the operator's editable prompt and appends the
    // fixed CORE_SCAFFOLD (machinery + security), then substitutes placeholders.
    const system = composeSystem(
      cfg.SYSTEM_PROMPT ?? "",
      {
        operatorName: cfg.OPERATOR_NAME || "el operador",
        masterStoreName: cfg.MEMORY_STORE_MASTER_NAME || "master",
        leadsStoreName: cfg.MEMORY_STORE_LEADS_NAME || "leads",
      },
      httpRows
    );

    // 4. Optimistic concurrency: read current version then PATCH.
    const doUpdate = async (): Promise<number> => {
      const current = await retrieveAgent(apiKey, agentId);
      const updated = await updateAgent(apiKey, agentId, {
        version: current.version,
        system,
        tools,
      });
      return (updated.version as number) ?? 0;
    };

    let newVersion: number;
    try {
      newVersion = await doUpdate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // On version-mismatch re-read once and retry. Match the 409 status or an
      // explicit "conflict" — NOT the bare word "version" (that also appears in
      // unrelated errors like a bad anthropic-version header).
      if (/\b409\b|conflict/i.test(msg)) {
        try {
          newVersion = await doUpdate();
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error("syncAgentTools: retry failed:", retryMsg);
          return { version: null, synced: false, error: retryMsg };
        }
      } else {
        console.error("syncAgentTools: updateAgent failed:", msg);
        return { version: null, synced: false, error: msg };
      }
    }

    // 5. Persist the bumped version so the editor page can show it.
    await setConfigValues(
      { ANTHROPIC_AGENT_VERSION: String(newVersion) },
      actor
    );

    return { version: newVersion, synced: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("syncAgentTools: unexpected error:", msg);
    return { version: null, synced: false, error: msg };
  }
}
