import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { approveDream } from "@/lib/memory-list";

// Aprueba un dream pendiente: lo mueve de /dreams-pending/ a /dreams/.
// A partir de ahí el agente lo lee como regla implícita al responder.
export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const res = await approveDream(params.id);
    if (!res) {
      return NextResponse.json(
        { error: "El dream no existe o no está pendiente" },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, path: res.path });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
