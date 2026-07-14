import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell } from "@/components/ui";
import { ToolEditor } from "./tool-editor";

export const dynamic = "force-dynamic";

export type AgentTool = {
  id: string;
  name: string;
  description: string;
  tool_type: "system" | "http";
  enabled: boolean;
  http_method: string | null;
  url_template: string | null;
  headers: Array<{ name: string; value: string }>;
  body_template: unknown | null;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  timeout_ms: number;
  created_at: string;
};

export default async function ToolsPage() {
  const supabase = createSupabaseServerClient();
  const { data: tools } = await supabase
    .from("agent_tools")
    .select("*")
    .order("tool_type", { ascending: false }) // 'system' > 'http'
    .order("created_at", { ascending: true });

  const rows = (tools ?? []) as AgentTool[];
  const enabledHttpCount = rows.filter(
    (t) => t.tool_type === "http" && t.enabled
  ).length;

  return (
    <PageShell
      title="Herramientas del agente"
      description="Conexiones HTTP a APIs externas (tus herramientas) y capacidades internas del sistema (búsqueda, memoria, acciones de CRM)."
    >
      <ToolEditor tools={rows} enabledHttpCount={enabledHttpCount} />
    </PageShell>
  );
}
