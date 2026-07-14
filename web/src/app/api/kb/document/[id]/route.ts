import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function safeName(base: string): string {
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "documento";
}

// Descarga el texto extraído del documento (lo que el agente realmente ve).
// No guardamos el binario original, solo el texto parseado en raw_text.
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("kb_documents")
    .select("title, raw_text, source_filename")
    .eq("id", params.id)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "no encontrado" }, { status: 404 });
  }

  const base = data.source_filename
    ? data.source_filename.replace(/\.[^.]+$/, "")
    : data.title;
  const filename = `${safeName(base)}.txt`;

  return new Response(data.raw_text ?? "", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // ON DELETE CASCADE en kb_chunks → se borran solos
  const { error } = await supabase.from("kb_documents").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
