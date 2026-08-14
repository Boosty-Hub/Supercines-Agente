import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((c: unknown): c is string => typeof c === "string")
        .map((c: string) => c.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

// Persiste el set de canales (origin de Kommo) que el agente ignora y, dentro de
// ese set, cuáles se clasifican y rutean igual (classify_only_channels, 0052).
//
// `classifyOnly` es opcional: si no viene, no se toca. Si viene, se INTERSECTA
// con los canales ignorados — un canal por el que el agente responde ya se
// clasifica, marcarlo acá no significaría nada y solo dejaría basura en la DB.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const channels = normalizeList(body.channels);

  const ignoredSet = new Set(channels);
  const update: Record<string, unknown> = { ignored_channels: channels };

  if (body.classifyOnly !== undefined) {
    update.classify_only_channels = normalizeList(body.classifyOnly).filter((c) =>
      ignoredSet.has(c)
    );
  } else {
    // Aunque el cliente no mande classifyOnly hay que PODAR: si el operador
    // vuelve a encender un canal, dejarlo en classify_only_channels sería
    // config zombie que no significa nada. Si la columna no existe todavía
    // (pre-migración 0052) el select falla y simplemente no la tocamos.
    const { data: current, error: readErr } = await supabase
      .from("kommo_publish_config")
      .select("classify_only_channels")
      .eq("is_active", true)
      .maybeSingle();
    if (!readErr && current) {
      const pruned = normalizeList(current.classify_only_channels).filter((c) =>
        ignoredSet.has(c)
      );
      update.classify_only_channels = pruned;
    }
  }

  const { error } = await supabase
    .from("kommo_publish_config")
    .update(update)
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
