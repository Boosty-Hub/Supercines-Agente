import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listDreams, readDream } from "@/lib/memory-list";

// Descarga TODOS los dreams del Memory Store master como un único
// archivo JSON. Cada entrada conserva `path` y `content` originales para
// poder reimportarse vía POST /api/dreams/import sin pérdida.
export async function GET() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const items = await listDreams();
    const dreams: Array<{ path: string; content: string }> = [];
    for (const it of items) {
      const d = await readDream(it.id);
      if (d) dreams.push({ path: d.path, content: d.content });
    }
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      memoryStore: "master",
      pathPrefix: "/dreams/",
      count: dreams.length,
      dreams,
    };
    const today = new Date().toISOString().slice(0, 10);
    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="dreams-export-${today}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
