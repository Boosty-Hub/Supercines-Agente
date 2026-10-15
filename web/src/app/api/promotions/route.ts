import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const PromotionBody = z.object({
  name: z.string().optional(),
  content: z.string().optional(),
  kind: z.enum(["promo", "evento"]).optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  weekdays: z.array(z.union([z.number(), z.string()])).nullable().optional(),
  enabled: z.boolean().optional(),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, PromotionBody);
  if (!input.ok) return input.response;
  const body = input.data;

  // Validar name y content
  const name = body.name?.trim() ?? "";
  if (!name) return NextResponse.json({ error: "El nombre es requerido" }, { status: 400 });
  const content = body.content?.trim() ?? "";
  if (!content) return NextResponse.json({ error: "El contenido es requerido" }, { status: 400 });

  // Validar kind
  const kind = body.kind ?? "promo";

  // Validar starts_at / ends_at
  const starts_at: string | null =
    body.starts_at && DATE_RE.test(body.starts_at) ? body.starts_at : null;
  const ends_at: string | null =
    body.ends_at && DATE_RE.test(body.ends_at) ? body.ends_at : null;

  if (body.starts_at && !starts_at)
    return NextResponse.json({ error: "Formato de fecha inválido para starts_at (debe ser YYYY-MM-DD)" }, { status: 400 });
  if (body.ends_at && !ends_at)
    return NextResponse.json({ error: "Formato de fecha inválido para ends_at (debe ser YYYY-MM-DD)" }, { status: 400 });

  if (starts_at && ends_at && starts_at > ends_at)
    return NextResponse.json({ error: "ends_at debe ser mayor o igual a starts_at" }, { status: 400 });

  // Validar weekdays
  let weekdays: number[] | null = null;
  if (body.weekdays && body.weekdays.length > 0) {
    const days = body.weekdays.map(Number);
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
  const supabase = await createSupabaseServerClient();
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
