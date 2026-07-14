import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();

  const title = String(body.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "El título es requerido" }, { status: 400 });
  const content = String(body.content ?? "").trim();
  if (!content) return NextResponse.json({ error: "El contenido es requerido" }, { status: 400 });

  const starts_at: string | null =
    body.starts_at && DATE_RE.test(String(body.starts_at)) ? String(body.starts_at) : null;
  const ends_at: string | null =
    body.ends_at && DATE_RE.test(String(body.ends_at)) ? String(body.ends_at) : null;

  if (body.starts_at && !starts_at)
    return NextResponse.json({ error: "Formato de fecha inválido para starts_at (debe ser YYYY-MM-DD)" }, { status: 400 });
  if (body.ends_at && !ends_at)
    return NextResponse.json({ error: "Formato de fecha inválido para ends_at (debe ser YYYY-MM-DD)" }, { status: 400 });
  if (starts_at && ends_at && starts_at > ends_at)
    return NextResponse.json({ error: "ends_at debe ser mayor o igual a starts_at" }, { status: 400 });

  const enabled = body.enabled !== false;

  const { error } = await supabase.from("situations").insert({
    title,
    content,
    starts_at,
    ends_at,
    enabled,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("situations")
    .select("id,title,content,starts_at,ends_at,enabled")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ situations: data ?? [] });
}
