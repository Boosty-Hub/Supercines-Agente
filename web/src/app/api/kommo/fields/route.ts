import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchCustomFields, createCustomField } from "@/lib/kommo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    const { configured, leads, contacts } = await fetchCustomFields();
    return NextResponse.json({ ok: true, configured, leads, contacts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}

// Crea un campo custom en Kommo al vuelo (desde el editor de seguimiento).
// El campo creado queda disponible al instante para asignarlo a una variable.
const ALLOWED_TYPES = ["text", "textarea", "numeric", "date", "url"];

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "El nombre del campo es requerido." }, { status: 400 });

  const entity = body.entity === "contacts" ? "contacts" : "leads";
  const rawType = String(body.type ?? "text");
  const type = ALLOWED_TYPES.includes(rawType) ? rawType : "text";

  try {
    const field = await createCustomField(entity, name, type);
    return NextResponse.json({ ok: true, field });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
