import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// La lista completa de etapas ignoradas (reemplaza la anterior; [] = ninguna).
const StagesBody = z.object({ stageIds: z.array(z.union([z.number(), z.string()])) });

// Persiste el set de etapas de Kommo (status_id) que el agente NO atiende.
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, StagesBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const stageIds = Array.from(
    new Set(body.stageIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))
  );

  const { error } = await supabase
    .from("kommo_publish_config")
    .update({ ignored_stage_ids: stageIds })
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
