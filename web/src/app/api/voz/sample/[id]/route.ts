import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { getMemoryClient } from "@/lib/memory";

function safeName(base: string): string {
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "sample";
}

// Descarga el contenido del sample de voz tal como se ingirió.
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireScope("contenido");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const { data, error } = await supabase
    .from("voice_samples")
    .select("title, content, source_filename")
    .eq("id", params.id)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "no encontrado" }, { status: 404 });
  }

  const base = data.source_filename
    ? data.source_filename.replace(/\.[^.]+$/, "")
    : data.title;
  const filename = `${safeName(base)}.txt`;

  return new Response(data.content ?? "", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireScope("contenido");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  // Fetch para recuperar memory_ids antes de borrar
  const { data: sample, error: fetchErr } = await supabase
    .from("voice_samples")
    .select("id, metadata")
    .eq("id", params.id)
    .single();
  if (fetchErr || !sample) {
    return NextResponse.json({ error: "no encontrado" }, { status: 404 });
  }

  const memoryIds = ((sample.metadata as Record<string, unknown>)?.memory_ids ?? []) as string[];
  if (memoryIds.length > 0) {
    try {
      const memory = await getMemoryClient();
      await memory.deleteByIds("master", memoryIds);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `memory store: ${msg}` }, { status: 502 });
    }
  }

  const { error } = await supabase.from("voice_samples").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, memory_deleted: memoryIds.length });
}
