import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { parseTerms } from "@/lib/routing";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createSupabaseServerClient();
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
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const kommoUserId = Number(body.kommo_user_id);
  if (!Number.isFinite(kommoUserId) || kommoUserId <= 0) {
    return NextResponse.json({ error: "kommo_user_id inválido" }, { status: 400 });
  }

  // sort_order al final de la rueda si no lo mandan, para no empatar con otro.
  let sortOrder = Number(body.sort_order);
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
