import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  BOARD_PAGE,
  normalizePage,
  parseCursor,
  parseFilters,
  parseLimit,
  parsePipeline,
  parseSort,
  parseStage,
  type InboxPage,
} from "@/lib/inbox-query";
import { inboxRpcError, rpcOrThrow } from "@/lib/inbox-rpc";

export const dynamic = "force-dynamic";

// Página siguiente de UNA rebanada del inbox (migración 0079): «Ver más» de una columna del
// tablero o el scroll de la lista. Paginación por keyset: `after` es el cursor `next` que
// devolvió la página anterior (JSON), nunca un offset, así que un lead que se mueve mientras
// se pagina no hace repetir ni saltar filas del resto.
//
// Query: pipeline (id, -1, -2; sin pipeline = todos: vista Lista), stage (id, `otras`, `all`),
// after, limit y los mismos filtros/orden que la URL del inbox.
// Mismo modelo de acceso que /api/inbox/leads: middleware (alcance operacion) + RLS.
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const after = parseCursor(sp.get("after"));
  if (after === null) {
    return NextResponse.json({ error: "Cursor inválido", code: "invalid_query" }, { status: 400 });
  }
  const pipeline = parsePipeline(sp);
  const supabase = await createSupabaseServerClient();
  try {
    const page = await rpcOrThrow(supabase, "inbox_page", {
      p_pipeline: pipeline,
      p_stage: pipeline != null && pipeline > 0 ? parseStage(sp.get("stage")) : null,
      p_filters: parseFilters(sp),
      p_sort: parseSort(sp),
      p_after: after ?? null,
      p_limit: parseLimit(sp.get("limit"), BOARD_PAGE),
    });
    const body: InboxPage = normalizePage(page as Parameters<typeof normalizePage>[0]);
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return inboxRpcError(e);
  }
}
