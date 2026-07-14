import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createDream, listDreams } from "@/lib/memory-list";

type DreamEntry = { path: string; content: string };

// Sube dreams al master Memory Store desde un export JSON. Acepta el formato emitido
// por GET /api/dreams/export o un array simple [{path, content}].
// Idempotente: paths ya presentes se omiten (skipped) para evitar duplicados
// al re-subir el mismo archivo.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const rawDreams: unknown = Array.isArray(body)
    ? body
    : (body as { dreams?: unknown })?.dreams;
  if (!Array.isArray(rawDreams)) {
    return NextResponse.json(
      { error: "Formato esperado: { dreams: [{ path, content }] } o un array" },
      { status: 400 }
    );
  }

  const entries: DreamEntry[] = [];
  for (const d of rawDreams) {
    if (
      d &&
      typeof d === "object" &&
      typeof (d as DreamEntry).path === "string" &&
      typeof (d as DreamEntry).content === "string" &&
      (d as DreamEntry).path.startsWith("/dreams/")
    ) {
      entries.push({ path: (d as DreamEntry).path, content: (d as DreamEntry).content });
    }
  }
  if (entries.length === 0) {
    return NextResponse.json({ error: "No hay entradas válidas con path /dreams/..." }, { status: 400 });
  }

  let existing: Set<string>;
  try {
    const list = await listDreams();
    existing = new Set(list.map((it) => it.path));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Listando existentes: ${msg}` }, { status: 500 });
  }

  let inserted = 0;
  let skipped = 0;
  const errors: Array<{ path: string; error: string }> = [];
  for (const entry of entries) {
    if (existing.has(entry.path)) {
      skipped++;
      continue;
    }
    try {
      await createDream(entry.path, entry.content);
      existing.add(entry.path);
      inserted++;
    } catch (err) {
      errors.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({
    ok: true,
    inserted,
    skipped,
    total: entries.length,
    errors,
  });
}
