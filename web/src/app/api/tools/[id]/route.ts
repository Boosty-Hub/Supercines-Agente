import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { syncAgentTools } from "@/lib/sync-agent-tools";

// nodejs runtime — calls Anthropic via syncAgentTools.
export const runtime = "nodejs";

/** PATCH /api/tools/[id] — partial update (fields + enabled toggle) */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Fetch the target row first to enforce the system-tool guard.
  const { data: existing, error: fetchErr } = await supabase
    .from("agent_tools")
    .select("id, tool_type")
    .eq("id", params.id)
    .maybeSingle();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "tool no encontrada" }, { status: 404 });

  if (existing.tool_type === "system") {
    return NextResponse.json(
      { error: "Las tools del sistema son inmutables" },
      { status: 403 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Build partial update — only accept writable fields.
  const update: Record<string, unknown> = {};
  if (typeof body.description === "string") update.description = body.description;
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;
  if (typeof body.http_method === "string")
    update.http_method = String(body.http_method).toUpperCase();
  if (typeof body.url_template === "string") {
    if (!body.url_template.startsWith("https://")) {
      return NextResponse.json(
        { error: "url_template debe comenzar con https://" },
        { status: 400 }
      );
    }
    update.url_template = body.url_template;
  }
  if (body.headers !== undefined) update.headers = body.headers;
  if (body.body_template !== undefined) update.body_template = body.body_template;
  if (body.input_schema !== undefined) update.input_schema = body.input_schema;
  if (typeof body.timeout_ms === "number")
    update.timeout_ms = Math.min(30000, Math.max(1000, Math.round(body.timeout_ms)));

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "sin campos para actualizar" }, { status: 400 });
  }

  const { error: updateErr } = await supabase
    .from("agent_tools")
    .update(update)
    .eq("id", params.id);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  const sync = await syncAgentTools(user.email ?? "dashboard").catch((e) => ({
    synced: false,
    version: null,
    error: String(e),
  }));

  return NextResponse.json({ ok: true, sync });
}

/** DELETE /api/tools/[id] — delete an http tool */
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: existing, error: fetchErr } = await supabase
    .from("agent_tools")
    .select("id, tool_type")
    .eq("id", params.id)
    .maybeSingle();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "tool no encontrada" }, { status: 404 });

  if (existing.tool_type === "system") {
    return NextResponse.json(
      { error: "Las tools del sistema son inmutables" },
      { status: 403 }
    );
  }

  const { error: deleteErr } = await supabase
    .from("agent_tools")
    .delete()
    .eq("id", params.id);

  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });

  const sync = await syncAgentTools(user.email ?? "dashboard").catch((e) => ({
    synced: false,
    version: null,
    error: String(e),
  }));

  return NextResponse.json({ ok: true, sync });
}
