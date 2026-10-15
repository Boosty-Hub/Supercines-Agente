import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const TemplatePatchBody = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  body: z.string().optional(),
  variables: z.array(z.record(z.unknown())).optional(),
  salesbot_id: z.union([z.number(), z.string(), z.null()]).optional(),
  enabled: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, props: Params) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, TemplatePatchBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.description !== undefined) patch.description = body.description || null;
  if (body.body !== undefined) patch.body = body.body;
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

export async function DELETE(_request: Request, props: Params) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
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
