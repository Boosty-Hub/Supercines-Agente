import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { syncAgentTools } from "@/lib/sync-agent-tools";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const ToolBody = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  http_method: z.string().optional(),
  url_template: z.string().optional(),
  // Los valores pueden referenciar secretos ({{TOOL_X}}): nunca se repiten en un error.
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  // JSON libre (objeto/array/valor) o null.
  body_template: z.unknown().optional(),
  input_schema: z.record(z.unknown()).optional(),
  timeout_ms: z.number().optional(),
});

// nodejs runtime — calls Anthropic via syncAgentTools.
export const runtime = "nodejs";

// Reserved system tool names — cannot be used for new http tools.
const RESERVED_NAMES = new Set(["search_kb", "agent_toolset_20260401"]);

/** GET /api/tools — list all tools (system + http) ordered by type desc, created_at asc */
export async function GET() {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const { data, error } = await supabase
    .from("agent_tools")
    .select("*")
    .order("tool_type", { ascending: false }) // 'system' > 'http'
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

/** POST /api/tools — create a new http tool */
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const input = await readJson(request, ToolBody);
  if (!input.ok) return input.response;
  const body = input.data;

  // Validate name: snake_case only [a-z0-9_], non-empty.
  const name = body.name?.trim() ?? "";
  if (!name) return NextResponse.json({ error: "name es requerido" }, { status: 400 });
  if (!/^[a-z0-9_]+$/.test(name)) {
    return NextResponse.json(
      { error: "name debe ser snake_case (solo letras minúsculas, dígitos y guiones bajos)" },
      { status: 400 }
    );
  }
  if (RESERVED_NAMES.has(name)) {
    return NextResponse.json(
      { error: `"${name}" es un nombre reservado del sistema` },
      { status: 400 }
    );
  }

  // Validate url_template: must start with https://
  const urlTemplate = body.url_template?.trim() ?? "";
  if (!urlTemplate) {
    return NextResponse.json({ error: "url_template es requerido" }, { status: 400 });
  }
  if (!urlTemplate.startsWith("https://")) {
    return NextResponse.json(
      { error: "url_template debe comenzar con https://" },
      { status: 400 }
    );
  }

  // Build the row to insert.
  const row: Record<string, unknown> = {
    name,
    description: body.description?.trim() ?? "",
    tool_type: "http",
    enabled: body.enabled !== false,
    http_method: (body.http_method ?? "GET").toUpperCase(),
    url_template: urlTemplate,
    headers: body.headers ?? [],
    body_template: body.body_template ?? null,
    input_schema: body.input_schema ?? {
      type: "object",
      properties: {},
      required: [],
    },
    // Clamp server-side (the UI also clamps) so a crafted request can't set an
    // absurd timeout that would hang the agent session.
    timeout_ms:
      body.timeout_ms !== undefined
        ? Math.min(30000, Math.max(1000, Math.round(body.timeout_ms)))
        : 8000,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from("agent_tools")
    .insert(row)
    .select("id")
    .single();

  if (insertErr) {
    // Unique constraint violation → 409
    if (insertErr.code === "23505") {
      return NextResponse.json(
        { error: `Ya existe una tool con el nombre "${name}"` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Fire-and-forget sync to Anthropic (CRUD already committed).
  const sync = await syncAgentTools(auth.writer).catch((e) => ({
    synced: false,
    version: null,
    error: String(e),
  }));

  return NextResponse.json({ ok: true, id: inserted.id, sync }, { status: 201 });
}
