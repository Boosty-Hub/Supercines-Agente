import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchPublishCfg, fetchBoardPipelines, toAgentStatusCfg } from "@/lib/inbox-data";
import {
  BOARD_PAGE,
  LIST_PAGE,
  normalizeBoard,
  normalizePage,
  parseFilters,
  parseLimit,
  parseLimits,
  parsePipeline,
  parseSort,
  parseVista,
  type InboxResponse,
  type InboxStats,
} from "@/lib/inbox-query";
import { inboxRpcError, rpcOrThrow } from "@/lib/inbox-rpc";

export const dynamic = "force-dynamic";

// Inbox (tablero o lista) PAGINADO EN LA BASE (migración 0079): la base devuelve solo lo que
// se ve —por columna, las primeras tarjetas + el total— con los filtros ya aplicados, y los
// números del encabezado. Antes se traían TODOS los leads (de a 1000, recalculando el resumen
// entero en cada página) y se filtraba en el navegador: 27–31 s con 16k leads.
//
// Query: los mismos parámetros que la URL del inbox (vista, pipeline, q, channel, vertical,
// estado, urgent, rango, sort) + `limits` (tablero: tarjetas ya cargadas por columna, para que
// la recarga en vivo no pierda los «Ver más») o `limit` (lista: filas ya cargadas).
//
// Sin getUser() propio: el middleware ya validó la sesión y el alcance de /api/inbox, y las
// funciones corren con el JWT del usuario (SECURITY INVOKER): sin sesión la RLS no devuelve
// nada y `anon` no tiene EXECUTE.
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const vista = parseVista(sp);
  const filters = parseFilters(sp);
  const sort = parseSort(sp);
  const limits = parseLimits(sp.get("limits"));
  if (limits === null) {
    return NextResponse.json({ error: "Parámetro limits inválido", code: "invalid_query" }, { status: 400 });
  }
  const supabase = await createSupabaseServerClient();
  try {
    const [main, stats, cfg, pipelines] = await Promise.all([
      vista === "tablero"
        ? rpcOrThrow(supabase, "inbox_board", {
            p_pipeline: parsePipeline(sp),
            p_filters: filters,
            p_sort: sort,
            p_limit: BOARD_PAGE,
            p_limits: limits ?? null,
          })
        : rpcOrThrow(supabase, "inbox_page", {
            p_pipeline: null,
            p_stage: null,
            p_filters: filters,
            p_sort: sort,
            p_after: null,
            p_limit: parseLimit(sp.get("limit"), LIST_PAGE),
          }),
      rpcOrThrow(supabase, "inbox_stats", { p_filters: filters }),
      fetchPublishCfg(supabase),
      fetchBoardPipelines(supabase),
    ]);
    const common = { stats: stats as InboxStats, agentCfg: toAgentStatusCfg(cfg), pipelines };
    const body: InboxResponse =
      vista === "tablero"
        ? { ...common, vista, board: normalizeBoard(main as Parameters<typeof normalizeBoard>[0]) }
        : { ...common, vista, list: normalizePage(main as Parameters<typeof normalizePage>[0]) };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return inboxRpcError(e);
  }
}
