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
  if (body.label !== undefined) patch.label = String(body.label).trim();
  if (body.kommo_field_id !== undefined) {
    const id = Number(body.kommo_field_id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ error: "kommo_field_id inválido" }, { status: 400 });
    }
    patch.kommo_field_id = id;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "sin campos para actualizar" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("follow_up_fields")
    .update(patch)
    .eq("id", params.id)
    .select("id, label, kommo_field_id")
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Ya existe un campo con ese kommo_field_id." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, field: data });
}

export async function DELETE(_request: Request, { params }: Params) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("follow_up_fields")
    .delete()
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
