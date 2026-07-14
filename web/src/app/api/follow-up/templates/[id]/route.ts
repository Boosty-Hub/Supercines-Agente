import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Params = { params: { id: string } };

export async function PATCH(request: Request, { params }: Params) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = String(body.name).trim();
  if (body.description !== undefined) patch.description = body.description ? String(body.description) : null;
  if (body.body !== undefined) patch.body = String(body.body);
  if (body.variables !== undefined) patch.variables = body.variables;
  if (body.salesbot_id !== undefined) patch.salesbot_id = body.salesbot_id ? Number(body.salesbot_id) : null;
  if (body.enabled !== undefined) patch.enabled = body.enabled === true;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "sin campos para actualizar" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("follow_up_templates")
    .update(patch)
    .eq("id", params.id)
    .select("id, name, description, body, variables, salesbot_id, enabled, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, template: data });
}

export async function DELETE(_request: Request, { params }: Params) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("follow_up_templates")
    .delete()
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
