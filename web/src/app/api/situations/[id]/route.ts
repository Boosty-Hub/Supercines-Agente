import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const SituationPatchBody = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, SituationPatchBody);
  if (!input.ok) return input.response;
  const body = input.data;
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
    } else if (body.starts_at !== undefined && DATE_RE.test(body.starts_at)) {
      update.starts_at = body.starts_at;
    } else {
      return NextResponse.json({ error: "Formato de fecha inválido para starts_at (debe ser YYYY-MM-DD)" }, { status: 400 });
    }
  }

  if ("ends_at" in body) {
    if (body.ends_at === null) {
      update.ends_at = null;
    } else if (body.ends_at !== undefined && DATE_RE.test(body.ends_at)) {
      update.ends_at = body.ends_at;
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

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase.from("situations").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
