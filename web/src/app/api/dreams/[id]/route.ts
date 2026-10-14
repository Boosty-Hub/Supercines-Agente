import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { deleteDream, triggerDigestRebuild } from "@/lib/memory-list";

// Borra un aprendizaje del master Memory Store. Al eliminarse el archivo,
// el agente deja de leerlo y no lo adopta en próximas respuestas.
export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireScope("contenido");
  if (!auth.ok) return auth.response;

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
