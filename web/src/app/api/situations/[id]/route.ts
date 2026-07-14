import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const update: Record<string, unknown> = {};

  if (typeof body.title === "string") {
    const title = body.title.trim();
    if (!title) return NextResponse.json({ error: "El título no puede estar vacío" }, { status: 400 });
    update.title = title;
  }

  if (typeof body.content === "string") {
    const content = body.content.trim();
    if (!content) return NextResponse.json({ error: "El contenido no puede estar vacío" }, { status: 400 });
    update.content = content;
  }

  if ("starts_at" in body) {
    if (body.starts_at === null) {
      update.starts_at = null;
    } else if (DATE_RE.test(String(body.starts_at))) {
      update.starts_at = String(body.starts_at);
    } else {
      return NextResponse.json({ error: "Formato de fecha inválido para starts_at (debe ser YYYY-MM-DD)" }, { status: 400 });
    }
  }

  if ("ends_at" in body) {
    if (body.ends_at === null) {
      update.ends_at = null;
    } else if (DATE_RE.test(String(body.ends_at))) {
      update.ends_at = String(body.ends_at);
    } else {
      return NextResponse.json({ error: "Formato de fecha inválido para ends_at (debe ser YYYY-MM-DD)" }, { status: 400 });
    }
  }

  const sa = (update.starts_at ?? null) as string | null;
  const ea = (update.ends_at ?? null) as string | null;
  if (sa && ea && sa > ea)
    return NextResponse.json({ error: "ends_at debe ser mayor o igual a starts_at" }, { status: 400 });

  if (typeof body.enabled === "boolean") update.enabled = body.enabled;

  const { error } = await supabase.from("situations").update(update).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase.from("situations").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
