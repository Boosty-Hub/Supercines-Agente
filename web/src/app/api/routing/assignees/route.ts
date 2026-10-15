import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { parseTerms } from "@/lib/routing";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const AssigneeCreateBody = z.object({
  kommo_user_id: z.number(),
  display_name: z.string().nullable().optional(),
  match_terms: z.union([z.string(), z.array(z.unknown())]).optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().optional(),
});

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("routing_assignees")
    .select("id, kommo_user_id, display_name, match_terms, enabled, sort_order")
    .order("sort_order")
    .order("kommo_user_id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, assignees: data ?? [] });
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, AssigneeCreateBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const kommoUserId = Number(body.kommo_user_id);
  if (!Number.isFinite(kommoUserId) || kommoUserId <= 0) {
    return NextResponse.json({ error: "kommo_user_id inválido" }, { status: 400 });
  }

  // sort_order al final de la rueda si no lo mandan, para no empatar con otro.
  let sortOrder = body.sort_order ?? Number.NaN;
  if (!Number.isFinite(sortOrder)) {
    const { data: last } = await supabase
      .from("routing_assignees")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    sortOrder = (last?.sort_order ?? -1) + 1;
  }

  const { error } = await supabase.from("routing_assignees").insert({
    kommo_user_id: kommoUserId,
    display_name: typeof body.display_name === "string" ? body.display_name.trim() || null : null,
    match_terms: parseTerms(body.match_terms),
    enabled: body.enabled !== false,
    sort_order: sortOrder,
  });
  if (error) {
    // unique(kommo_user_id): mensaje entendible en vez del error crudo de PG.
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Esa persona ya está en la lista de ruteo." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
