import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { checkAgentPromptConflict, syncAgentTools, type ConflictResolution } from "@/lib/sync-agent-tools";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// Sin cuerpo = sincronización normal; con conflicto de prompt, la resolución elegida.
const SyncBody = z.object({
  resolve: z.enum(["overwrite", "import_live"]).optional(),
  expectedLiveHash: z.string().optional(),
});

export const runtime = "nodejs";

// Alcance configuracion (prefijo /api/agent en lib/auth/roles.ts).
//
// POST /api/agent/sync — re-empuja el system prompt (SYSTEM_PROMPT del operador +
// CORE_SCAFFOLD vigente) y las tools al Managed Agent. NO modifica SYSTEM_PROMPT.
//
// SINCRONIZACIÓN SEGURA: antes de empujar compara el prompt VIVO contra lo último
// sincronizado (lib/agent-prompt-sync.ts). Si fue editado fuera del dashboard (o es la
// primera vez y difiere) NO sincroniza: responde 409 con el conflicto y el diff.
// El usuario decide con `{ "resolve": "overwrite" | "import_live" }`:
//   - overwrite:   empuja el prompt de la DB igual (pisa lo de afuera);
//   Ambos exigen `expectedLiveHash` (el hash del vivo que se le mostró al operador): si el
//   vivo cambió entre mostrar y resolver (TOCTOU) se ABORTA con 409 `{ stale: true }` y la UI
//   vuelve a mostrar el diff.
//   - import_live: no empuja; trae el prompt vivo del operador a la DB, restituyendo los
//                  placeholders conocidos (los valores ambiguos se informan y no se tocan).
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, SyncBody, { optional: true });
  if (!input.ok) return input.response;
  const resolve: ConflictResolution | undefined = input.data.resolve;
  const expectedLiveHash = input.data.expectedLiveHash || undefined;
  if (resolve && !expectedLiveHash) {
    return NextResponse.json(
      { ok: false, error: "Falta expectedLiveHash: recargá la página y volvé a elegir." },
      { status: 400 }
    );
  }

  const res = await syncAgentTools(auth.writer, { resolve, expectedLiveHash });
  if (res.stale) {
    return NextResponse.json(
      { ok: false, stale: true, error: res.error, conflict: res.conflict ?? null },
      { status: 409 }
    );
  }
  if (res.conflict) {
    return NextResponse.json({ ok: false, error: res.error, conflict: res.conflict }, { status: 409 });
  }
  if (!res.synced) {
    return NextResponse.json({ ok: false, error: res.error ?? "No hay agente aprovisionado" }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    version: res.version,
    imported: res.imported === true,
    placeholders: res.placeholders ?? null,
  });
}

// GET /api/agent/sync — ¿hay un conflicto de prompt pendiente? (sin modificar nada)
export async function GET() {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ ok: true, conflict: await checkAgentPromptConflict() });
}
