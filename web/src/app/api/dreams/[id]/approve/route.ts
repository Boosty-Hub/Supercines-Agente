import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { approveDream, triggerDigestRebuild } from "@/lib/memory-list";

// Aprueba un dream pendiente: lo mueve de /dreams-pending/ a /dreams/.
// A partir de ahí el agente lo lee como regla implícita al responder.
export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireScope("contenido");
  if (!auth.ok) return auth.response;

  try {
    const res = await approveDream(params.id);
    if (!res) {
      return NextResponse.json(
        { error: "El dream no existe o no está pendiente" },
        { status: 404 }
      );
    }
    await triggerDigestRebuild();
    return NextResponse.json({ ok: true, path: res.path });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
