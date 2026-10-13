import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { deleteDream, triggerDigestRebuild } from "@/lib/memory-list";

// Borra un aprendizaje del master Memory Store. Al eliminarse el archivo,
// el agente deja de leerlo y no lo adopta en próximas respuestas.
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const { wasActive } = await deleteDream(params.id);
    // Solo un dream ACTIVO forma parte del digest: borrar un pendiente no lo cambia.
    if (wasActive) await triggerDigestRebuild();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
