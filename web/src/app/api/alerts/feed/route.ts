import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Feed de la torre de control. Existe como API (y no como server component)
// porque el panel vive montado en el layout y tiene que poder refrescarse solo
// —tras marcar algo como visto, o al navegar— sin desmontarse ni cerrarse.
export const dynamic = "force-dynamic";

export type FeedItem = {
  id: string;
  kind: string;
  severity: string;
  title: string;
  description: string | null;
  createdAt: string;
  /** Ruta a la que navega el ítem. null = no hay a dónde ir. */
  href: string | null;
};

export type FeedSystemStatus = {
  agentEnabled: boolean;
  publishingEnabled: boolean;
};

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [{ data: alertsRaw }, { data: pubCfg }] = await Promise.all([
    supabase
      .from("alerts")
      .select("id, kind, severity, title, description, ref_table, ref_id, created_at, acknowledged_at")
      .is("acknowledged_at", null)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("kommo_publish_config")
      .select("agent_enabled, publishing_enabled")
      .eq("is_active", true)
      .maybeSingle(),
  ]);

  const rows = alertsRaw ?? [];

  // Resolver el lead de cada alerta para poder abrir la conversación exacta —
  // mismo patrón de dos consultas en lote que /alerts (no una consulta por alerta).
  const leadByAlert = new Map<string, string>();

  const msgIds = rows.filter((a) => a.ref_table === "messages" && a.ref_id).map((a) => a.ref_id as string);
  if (msgIds.length > 0) {
    const { data: msgs } = await supabase.from("messages").select("id, lead_id").in("id", msgIds);
    const leadByMsg = new Map((msgs ?? []).map((m) => [m.id as string, m.lead_id as string]));
    for (const a of rows) {
      if (a.ref_table === "messages" && a.ref_id) {
        const lead = leadByMsg.get(a.ref_id);
        if (lead) leadByAlert.set(a.id, lead);
      }
    }
  }

  const draftIds = rows.filter((a) => a.ref_table === "drafts" && a.ref_id).map((a) => a.ref_id as string);
  if (draftIds.length > 0) {
    const { data: drs } = await supabase.from("drafts").select("id, messages!drafts_message_id_fkey(lead_id)").in("id", draftIds);
    for (const d of (drs ?? []) as Array<{
      id: string;
      messages: { lead_id: string } | { lead_id: string }[] | null;
    }>) {
      const m = Array.isArray(d.messages) ? d.messages[0] : d.messages;
      if (!m?.lead_id) continue;
      const alerta = rows.find((a) => a.ref_table === "drafts" && a.ref_id === d.id);
      if (alerta) leadByAlert.set(alerta.id, m.lead_id);
    }
  }

  function hrefFor(a: (typeof rows)[number]): string | null {
    const lead = leadByAlert.get(a.id);
    if (lead) return `/inbox/${lead}`;
    if (a.ref_table === "messages" || a.ref_table === "drafts") return "/inbox";
    return null;
  }

  const items: FeedItem[] = rows.map((a) => ({
    id: a.id as string,
    kind: a.kind as string,
    severity: (a.severity as string) ?? "warning",
    title: a.title as string,
    description: (a.description as string) ?? null,
    createdAt: a.created_at as string,
    href: hrefFor(a),
  }));

  // generate-response solo bloquea con agent_enabled === false explícito (mismo
  // criterio que /inbox y /agent); publishing_enabled arranca en false.
  const systemStatus: FeedSystemStatus = {
    agentEnabled: pubCfg?.agent_enabled !== false,
    publishingEnabled: pubCfg?.publishing_enabled === true,
  };

  return NextResponse.json({ items, systemStatus });
}
