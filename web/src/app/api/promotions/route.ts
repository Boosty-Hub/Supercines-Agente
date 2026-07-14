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

  // Validar name y content
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "El nombre es requerido" }, { status: 400 });
  const content = String(body.content ?? "").trim();
  if (!content) return NextResponse.json({ error: "El contenido es requerido" }, { status: 400 });

  // Validar kind
  const kind = String(body.kind ?? "promo");
  if (kind !== "promo" && kind !== "evento") {
    return NextResponse.json({ error: "kind debe ser 'promo' o 'evento'" }, { status: 400 });
  }

  // Validar starts_at / ends_at
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

  // Validar weekdays
  let weekdays: number[] | null = null;
  if (Array.isArray(body.weekdays) && body.weekdays.length > 0) {
    const days = (body.weekdays as unknown[]).map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
      return NextResponse.json({ error: "Los días de la semana deben ser valores entre 1 (lunes) y 7 (domingo)" }, { status: 400 });
    weekdays = Array.from(new Set(days)).sort((a, b) => a - b);
  }

  const enabled = body.enabled !== false;

  const { error } = await supabase.from("promotions").insert({
    name,
    content,
    kind,
    starts_at,
    ends_at,
    weekdays,
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
    .from("promotions")
    .select("id,name,content,kind,starts_at,ends_at,weekdays,enabled")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ promotions: data ?? [] });
}
