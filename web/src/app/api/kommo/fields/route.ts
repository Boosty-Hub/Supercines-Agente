import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { fetchCustomFields, createCustomField } from "@/lib/kommo";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

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
const FieldBody = z.object({
  name: z.string().optional(),
  entity: z.enum(["leads", "contacts"]).optional(),
  type: z.enum(["text", "textarea", "numeric", "date", "url"]).optional(),
});

export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, FieldBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const name = body.name?.trim() ?? "";
  if (!name) return NextResponse.json({ ok: false, error: "El nombre del campo es requerido." }, { status: 400 });

  const entity = body.entity ?? "leads";
  const type = body.type ?? "text";

  try {
    const field = await createCustomField(entity, name, type);
    return NextResponse.json({ ok: true, field });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
