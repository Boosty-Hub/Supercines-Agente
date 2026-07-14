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

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "El nombre no puede estar vacío" }, { status: 400 });
    update.name = name;
  }

  if (typeof body.content === "string") {
    const content = body.content.trim();
    if (!content) return NextResponse.json({ error: "El contenido no puede estar vacío" }, { status: 400 });
    update.content = content;
  }

  if (body.kind !== undefined) {
    if (body.kind !== "promo" && body.kind !== "evento")
      return NextResponse.json({ error: "kind debe ser 'promo' o 'evento'" }, { status: 400 });
    update.kind = body.kind;
  }

  // starts_at / ends_at — aceptar null explícito o string YYYY-MM-DD
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

  // Validar rango si ambas fechas están presentes en el update final
  const sa = (update.starts_at ?? null) as string | null;
  const ea = (update.ends_at ?? null) as string | null;
  if (sa && ea && sa > ea)
    return NextResponse.json({ error: "ends_at debe ser mayor o igual a starts_at" }, { status: 400 });

  if ("weekdays" in body) {
    if (body.weekdays === null) {
      update.weekdays = null;
    } else if (Array.isArray(body.weekdays)) {
      const days = (body.weekdays as unknown[]).map(Number);
      if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
        return NextResponse.json({ error: "Los días de la semana deben ser valores entre 1 (lunes) y 7 (domingo)" }, { status: 400 });
      update.weekdays = Array.from(new Set(days)).sort((a, b) => a - b);
    }
  }

  if (typeof body.enabled === "boolean") update.enabled = body.enabled;

  const { error } = await supabase.from("promotions").update(update).eq("id", params.id);
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

  const { error } = await supabase.from("promotions").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
