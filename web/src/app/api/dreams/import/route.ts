import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { createDream, listDreams, triggerDigestRebuild } from "@/lib/memory-list";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// Export de /dreams: un array de { path, content } o { dreams: [...] }. Las entradas sueltas
// inválidas se descartan en la ruta (import tolerante); el contenedor tiene que ser uno de los dos.
const DreamsImportBody = z.union([z.array(z.unknown()), z.object({ dreams: z.array(z.unknown()) })], {
  errorMap: () => ({ message: "Formato esperado: { dreams: [{ path, content }] } o un array" }),
});

type DreamEntry = { path: string; content: string };

// Sube dreams al master Memory Store desde un export JSON. Acepta el formato emitido
// por GET /api/dreams/export o un array simple [{path, content}].
// Idempotente: paths ya presentes se omiten (skipped) para evitar duplicados
// al re-subir el mismo archivo.
export async function POST(request: Request) {
  const auth = await requireScope("contenido");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, DreamsImportBody);
  if (!input.ok) return input.response;
  const rawDreams = Array.isArray(input.data) ? input.data : input.data.dreams;

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

  if (inserted > 0) await triggerDigestRebuild();

  return NextResponse.json({
    ok: true,
    inserted,
    skipped,
    total: entries.length,
    errors,
  });
}
