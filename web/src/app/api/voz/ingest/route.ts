import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { autoParse } from "@/lib/parsers";
import { chunkBlocks } from "@/lib/chunking";
import { getMemoryClient } from "@/lib/memory";

const VALID_TYPES = ["chat_export", "transcript", "rule", "example_response"] as const;
type SampleType = (typeof VALID_TYPES)[number];

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await request.formData();
  const type = form.get("type") as SampleType | null;
  const title = (form.get("title") as string | null)?.trim();
  const file = form.get("file") as File | null;
  const inlineContent = form.get("content") as string | null;
  const operatorName =
    (form.get("operator_name") as string | null)?.trim() ||
    process.env.OPERATOR_NAME ||
    "";

  if (!type || !VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: "type inválido" }, { status: 400 });
  }
  if (!title) {
    return NextResponse.json({ error: "title requerido" }, { status: 400 });
  }
  const rawContent = file ? await file.text() : inlineContent ?? "";
  if (!rawContent.trim()) {
    return NextResponse.json({ error: "contenido vacío" }, { status: 400 });
  }
  const filename = file?.name ?? "inline.txt";

  // Parsear → bloques
  const blocks = autoParse(filename, rawContent, operatorName || undefined);
  if (blocks.length === 0) {
    return NextResponse.json({ error: "no se pudo parsear" }, { status: 400 });
  }

  // Chunkear
  const chunkOpts =
    type === "transcript"
      ? { maxTokens: 500, overlapTokens: 80 }
      : type === "rule"
      ? { maxTokens: 800, overlapTokens: 0 }
      : { maxTokens: 400, overlapTokens: 50 };
  const chunks = chunkBlocks(blocks, chunkOpts);

  // Crear voice_sample (registro maestro en Supabase)
  const baseMeta = {
    parser: filename.match(/\.(srt|vtt|txt|md)$/i)?.[1] ?? "auto",
    blocks_count: blocks.length,
    chunks_count: chunks.length,
    operator_name: operatorName,
  };
  const { data: sample, error: sampleErr } = await supabase
    .from("voice_samples")
    .insert({
      type,
      title,
      content: rawContent,
      source_filename: filename,
      metadata: baseMeta,
    })
    .select("id")
    .single();
  if (sampleErr || !sample) {
    return NextResponse.json(
      { error: sampleErr?.message ?? "no se pudo crear sample" },
      { status: 500 }
    );
  }

  // Insertar cada chunk como archivo en el master Memory Store
  // Paths quedan: /voice/{type}/{sample_id}_{n}.md
  const memory = await getMemoryClient();
  let memoryIds: string[] = [];
  try {
    memoryIds = await memory.insertMany(
      chunks.map((c, idx) => ({
        storeName: "master",
        sourceKind: `voice/${type}`,
        sourceId: sample.id,
        content: c.content,
        metadata: {
          ...c.metadata,
          chunk_index: idx,
          title,
          voice_type: type,
        },
      }))
    );
  } catch (err) {
    // Rollback: si falla la ingesta a Anthropic, borramos el sample para no dejar huérfano
    await supabase.from("voice_samples").delete().eq("id", sample.id);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `memory store: ${msg}` }, { status: 502 });
  }

  // Marcar sample como ingerido con los memory_ids
  await supabase
    .from("voice_samples")
    .update({
      ingested_at: new Date().toISOString(),
      metadata: { ...baseMeta, memory_ids: memoryIds },
    })
    .eq("id", sample.id);

  return NextResponse.json({
    ok: true,
    sample_id: sample.id,
    chunks: chunks.length,
    blocks: blocks.length,
    memory_ids: memoryIds.length,
  });
}
