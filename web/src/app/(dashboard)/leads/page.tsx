import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Badge, EmptyState, PageShell, StatRow, StatCard, Users, Clock, Alert, MessageSquare } from "@/components/ui";
import { timeAgo } from "@/lib/time-ago";
import InboxFilters from "../inbox/filters";

export const dynamic = "force-dynamic";

type SearchParams = {
  q?: string;
  channel?: string;
  vertical?: string;
  estado?: string;
  urgent?: string;
  rango?: string;
  sort?: string;
};

function withinRange(iso: string | null, rango: string): boolean {
  if (!rango) return true;
  if (!iso) return false;
  const age = Date.now() - new Date(iso).getTime();
  const H = 3600_000;
  const D = 24 * H;
  if (rango === "1h") return age <= H;
  if (rango === "today") return age <= D;
  if (rango === "7d") return age <= 7 * D;
  if (rango === "30d") return age <= 30 * D;
  return true;
}

function normChannel(ch: string | null): string {
  if (!ch) return "other";
  const c = ch.toLowerCase();
  if (c.includes("whatsapp") || c === "waba") return "whatsapp";
  if (c.includes("instagram")) return "instagram";
  if (c.includes("facebook") || c === "fb") return "facebook";
  if (c.includes("tiktok")) return "tiktok";
  if (c.includes("telegram")) return "telegram";
  return "other";
}


type LeadRow = {
  id: string;
  display_name: string | null;
  channel: string | null;
  kommo_lead_id: number | null;
  first_seen_at: string | null;
  last_message_at: string | null;
  messages: Array<{
    direction: string;
    requires_human_review: boolean;
    created_at: string;
    classification: Record<string, unknown> | null;
    verticals: { slug: string } | { slug: string }[] | null;
  }>;
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from("leads")
    .select(
      "id, display_name, channel, kommo_lead_id, first_seen_at, last_message_at, messages(direction, requires_human_review, created_at, classification, verticals(slug))"
    )
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(200);

  const leads = (data ?? []) as LeadRow[];

  const allRows = leads.map((l) => {
    const msgs = l.messages ?? [];
    const inbound = msgs.filter((m) => m.direction === "inbound").length;
    const pendingReview = msgs.some(
      (m) => m.direction === "inbound" && m.requires_human_review
    );
    const sorted = [...msgs].sort(
      (a, b) => +new Date(b.created_at) - +new Date(a.created_at)
    );
    const lastV = sorted[0]?.verticals;
    const vertical = (Array.isArray(lastV) ? lastV[0]?.slug : lastV?.slug) ?? null;
    const lastDirection = sorted[0]?.direction ?? null;
    const verticals = Array.from(
      new Set(
        msgs
          .map((m) => {
            const v = m.verticals;
            return Array.isArray(v) ? v[0]?.slug : v?.slug;
          })
          .filter(Boolean) as string[]
      )
    );
    let maxUrgency = 0;
    let maxToxicity = 0;
    for (const m of msgs) {
      const cls = (m.classification ?? {}) as Record<string, unknown>;
      maxUrgency = Math.max(maxUrgency, Number(cls.urgency ?? 0) || 0);
      maxToxicity = Math.max(maxToxicity, Number(cls.toxicity ?? 0) || 0);
    }
    return {
      id: l.id,
      display_name: l.display_name,
      channel: l.channel,
      kommo_lead_id: l.kommo_lead_id,
      first_seen_at: l.first_seen_at,
      last_message_at: l.last_message_at,
      total: msgs.length,
      inbound,
      pendingReview,
      vertical,
      verticals,
      lastDirection,
      maxUrgency,
      maxToxicity,
    };
  });

  const channelOptions = Array.from(
    new Set(allRows.map((r) => normChannel(r.channel)))
  ).sort();
  const verticalOptions = Array.from(
    new Set(allRows.flatMap((r) => r.verticals))
  ).sort();

  const fQ = (searchParams.q ?? "").trim().toLowerCase();
  const fChannel = searchParams.channel ?? "";
  const fVertical = searchParams.vertical ?? "";
  const fEstado = searchParams.estado ?? "";
  const fUrgent = searchParams.urgent === "1";
  const fRango = searchParams.rango ?? "";
  const fSort = searchParams.sort ?? "recent";

  const rows = allRows
    .filter((r) => {
      if (fQ) {
        const hay = `${r.display_name ?? ""} ${r.kommo_lead_id ?? ""}`.toLowerCase();
        if (!hay.includes(fQ)) return false;
      }
      if (fChannel && normChannel(r.channel) !== fChannel) return false;
      if (fVertical && !r.verticals.includes(fVertical)) return false;
      if (fUrgent && r.maxUrgency < 4) return false;
      if (fEstado === "review" && !r.pendingReview) return false;
      if (fEstado === "waiting" && r.lastDirection !== "inbound") return false;
      if (fEstado === "answered" && r.lastDirection !== "outbound") return false;
      if (fEstado === "toxic" && r.maxToxicity <= 0.3) return false;
      if (fRango && !withinRange(r.last_message_at, fRango)) return false;
      return true;
    })
    .sort((a, b) => {
      const ta = a.last_message_at ? +new Date(a.last_message_at) : 0;
      const tb = b.last_message_at ? +new Date(b.last_message_at) : 0;
      if (fSort === "oldest") return ta - tb;
      if (fSort === "urgency") return b.maxUrgency - a.maxUrgency || tb - ta;
      if (fSort === "messages") return b.total - a.total || tb - ta;
      return tb - ta; // recent (default)
    });

  const totalLeads = allRows.length;
  const withPending = allRows.filter((r) => r.pendingReview).length;
  const withUrgent = allRows.filter((r) => r.maxUrgency >= 4).length;
  const lastContact = allRows[0]?.last_message_at;

  const hasActiveFilters =
    !!fQ ||
    !!fChannel ||
    !!fVertical ||
    !!fEstado ||
    fUrgent ||
    !!fRango ||
    fSort !== "recent";

  return (
    <PageShell
      title="Leads"
      toolbar={
        <InboxFilters
          channels={channelOptions}
          verticals={verticalOptions}
          searchPlaceholder="Buscar nombre o kommo id…"
        />
      }
    >
      {/* KPI row */}
      <StatRow>
        <StatCard
          label="Total leads"
          value={totalLeads}
          icon={<Users size={18} />}
          tone="brand"
        />
        <StatCard
          label="Revisión pendiente"
          value={withPending}
          icon={<MessageSquare size={18} />}
          tone={withPending > 0 ? "amber" : "default"}
        />
        <StatCard
          label="Urgentes"
          value={withUrgent}
          icon={<Alert size={18} />}
          tone={withUrgent > 0 ? "red" : "default"}
        />
        <StatCard
          label="Último contacto"
          value={lastContact ? timeAgo(lastContact) : "—"}
          icon={<Clock size={18} />}
          tone="default"
        />
      </StatRow>

      {/* Filtros activos info */}
      {hasActiveFilters && (
        <p className="text-xs text-neutral-500">
          Mostrando {rows.length} de {totalLeads} leads
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title={hasActiveFilters ? "Ningún lead coincide con los filtros." : "Sin leads todavía."}
          description={hasActiveFilters ? "Probá ajustar o limpiar los filtros." : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 bg-neutral-50/60 text-left">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Lead</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Canal</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Vertical</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Mensajes</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Primer contacto</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Último mensaje</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-neutral-50/70 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-neutral-900">
                          {r.display_name ?? `Lead ${r.kommo_lead_id ?? "?"}`}
                        </span>
                        {r.pendingReview && <Badge color="amber">Revisión</Badge>}
                        {r.maxUrgency >= 4 && <Badge color="red">Urgente {r.maxUrgency}</Badge>}
                      </div>
                      <span className="text-xs text-neutral-400 font-mono">
                        ID: {r.kommo_lead_id ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.channel ? <Badge color="neutral">{r.channel}</Badge> : <span className="text-xs text-neutral-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {r.vertical ? <Badge color="blue">{r.vertical}</Badge> : <span className="text-xs text-neutral-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-600">
                      {r.total} ({r.inbound} entrantes)
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500">
                      {r.first_seen_at ? timeAgo(r.first_seen_at) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500">
                      {r.last_message_at ? timeAgo(r.last_message_at) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/inbox?lead=${r.id}`}
                        className="text-xs font-medium text-brand hover:text-brand-strong transition-colors"
                      >
                        Ver →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Pie de tabla */}
          <div className="border-t border-neutral-100 px-4 py-2.5 text-xs text-neutral-500">
            {hasActiveFilters
              ? `Mostrando ${rows.length} de ${totalLeads} leads`
              : `${totalLeads} leads en total`}
          </div>
        </div>
      )}
    </PageShell>
  );
}
