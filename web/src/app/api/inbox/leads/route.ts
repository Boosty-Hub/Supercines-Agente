import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  fetchLeadSummaries,
  fetchPublishCfg,
  fetchBoardPipelines,
  toAgentStatusCfg,
  type InboxListData,
} from "@/lib/inbox-data";

export const dynamic = "force-dynamic";

// Lista del inbox (lista y tablero). La pide el cliente (inbox-shell.tsx) al
// montar y cuando llega un cambio en vivo — NO el server component — para que
// abrir una conversación no vuelva a calcular la lista entera: antes cada clic
// re-renderizaba la página completa con todos los mensajes embebidos.
//
// Sin getUser() propio: el middleware ya validó la sesión y el alcance de
// /api/inbox, y la consulta corre con el JWT del usuario, así que sin sesión la
// RLS (y el revoke a `anon` de inbox_lead_summaries) la rechaza igual.
export async function GET() {
  const supabase = await createSupabaseServerClient();
  try {
    const [leads, cfg, pipelines] = await Promise.all([
      fetchLeadSummaries(supabase),
      fetchPublishCfg(supabase),
      fetchBoardPipelines(supabase),
    ]);
    const body: InboxListData = { leads, agentCfg: toAgentStatusCfg(cfg), pipelines };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
