import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Persiste el set de etapas de Kommo (status_id) que el agente NO atiende.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const stageIds = Array.isArray(body.stageIds)
    ? Array.from(
        new Set(
          body.stageIds
            .map((n: unknown) => Number(n))
            .filter((n: number) => Number.isFinite(n) && n > 0)
        )
      )
    : [];

  const { error } = await supabase
    .from("kommo_publish_config")
    .update({ ignored_stage_ids: stageIds })
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
