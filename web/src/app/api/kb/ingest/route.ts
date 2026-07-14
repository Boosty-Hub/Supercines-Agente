import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { parseDocument, chunkText } from "@/lib/kb-parsers";
import { embedTexts } from "@/lib/embed";

export const maxDuration = 60;

const ACCEPTED = new Set(["pdf", "docx", "txt", "md", "srt", "vtt"]);

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await request.formData();
  const file = form.get("file") as File | null;
  const title = (form.get("title") as string | null)?.trim();
  const inlineContent = form.get("content") as string | null;

  if (!title) return NextResponse.json({ error: "title requerido" }, { status: 400 });

  let text: string;
  let format: string;
  let filename: string;

  if (file) {
    filename = file.name;
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    if (!ACCEPTED.has(ext)) {
      return NextResponse.json(
        { error: `formato no soportado: .${ext}. Acepta: ${Array.from(ACCEPTED).join(", ")}` },
        { status: 400 }
      );
    }
    const buf = await file.arrayBuffer();
    const parsed = await parseDocument(buf, filename);
    text = parsed.text;
    format = parsed.format;
  } else if (inlineContent?.trim()) {
    filename = "inline.md";
    text = inlineContent;
    format = "md";
  } else {
    return NextResponse.json({ error: "subí archivo o pegá contenido" }, { status: 400 });
  }

  if (text.trim().length < 50) {
    return NextResponse.json({ error: "contenido demasiado corto (<50 chars)" }, { status: 400 });
  }

  // Chunkear
  const chunks = chunkText(text, { maxTokens: 450, overlapTokens: 60 });
  if (chunks.length === 0) {
    return NextResponse.json({ error: "chunking produjo 0 chunks" }, { status: 400 });
  }

  // Crear documento maestro
  const { data: doc, error: docErr } = await supabase
    .from("kb_documents")
    .insert({
      title,
      source_type: format,
      source_filename: filename,
      raw_text: text,
      embeddings_provider: "supabase_ai_gte_small",
      embeddings_dim: 384,
      total_chunks: chunks.length,
      metadata: { format },
    })
    .select("id")
    .single();
  if (docErr || !doc) {
    return NextResponse.json({ error: docErr?.message ?? "no se pudo crear documento" }, { status: 500 });
  }

  // Embeber chunks
  let embeddings: number[][];
  try {
    embeddings = await embedTexts(chunks);
  } catch (err) {
    await supabase.from("kb_documents").delete().eq("id", doc.id);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `embed: ${msg}` }, { status: 502 });
  }

  // Insertar chunks
  const { error: chunksErr } = await supabase.from("kb_chunks").insert(
    chunks.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: embeddings[i],
      token_count: Math.ceil(content.split(/\s+/).length * 1.3),
      metadata: {},
    }))
  );
  if (chunksErr) {
    await supabase.from("kb_documents").delete().eq("id", doc.id);
    return NextResponse.json({ error: chunksErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    document_id: doc.id,
    chunks: chunks.length,
    chars: text.length,
  });
}
