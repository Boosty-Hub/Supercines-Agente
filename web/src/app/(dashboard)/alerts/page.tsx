import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Badge, Button, PageShell, StatRow, StatCard, EmptyState, Bell, Alert, Check } from "@/components/ui";
import { timeAgo } from "@/lib/time-ago";
import { AcknowledgeButton, AcknowledgeAllButton } from "./alert-actions";
import AlertsRealtime from "./realtime";

export const dynamic = "force-dynamic";

type Alert = {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string | null;
  ref_table: string | null;
  ref_id: string | null;
  created_at: string;
  acknowledged_at: string | null;
};

// Severity in plain language (no "critical/warning/info" jargon).
const severityMeta: Record<string, { label: string; cls: string }> = {
  critical: { label: "Urgente", cls: "bg-red-100 text-red-700" },
  warning: { label: "Atención", cls: "bg-amber-100 text-amber-700" },
  info: { label: "Info", cls: "bg-blue-100 text-blue-700" },
};

// Friendly label + icon per alert kind (the system stores a raw slug).
const kindMeta: Record<string, { label: string; icon: string }> = {
  draft_failed: { label: "Falló una respuesta", icon: "🔴" },
  human_review_needed: { label: "Necesita tu revisión", icon: "🟡" },
  outcomes_regression: { label: "Bajó la calidad", icon: "📉" },
};

function kindLabel(kind: string): { label: string; icon: string } {
  return kindMeta[kind] ?? { label: kind, icon: "⚪" };
}


function linkFor(alert: Alert, leadByAlert: Map<string, string>): string | null {
  const leadId = leadByAlert.get(alert.id);
  if (leadId) return `/inbox?lead=${leadId}`;
  if (alert.ref_table === "messages" || alert.ref_table === "drafts") return `/inbox`;
  return null;
}

export default async function AlertsPage({ searchParams }: { searchParams: { show?: string } }) {
  const showAcked = searchParams.show === "all";
  const supabase = createSupabaseServerClient();

  const query = supabase
    .from("alerts")
    .select("id, kind, severity, title, description, ref_table, ref_id, created_at, acknowledged_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (!showAcked) query.is("acknowledged_at", null);
  const { data: alerts } = await query;
  const rows = (alerts ?? []) as Alert[];

  // Resolver lead_id de cada alerta para linkear a la conversación exacta.
  const msgRefIds = rows
    .filter((a) => a.ref_table === "messages" && a.ref_id)
    .map((a) => a.ref_id as string);
  const draftRefIds = rows
    .filter((a) => a.ref_table === "drafts" && a.ref_id)
    .map((a) => a.ref_id as string);

  const leadByAlert = new Map<string, string>();

  if (msgRefIds.length > 0) {
    const { data: msgs } = await supabase
      .from("messages")
      .select("id, lead_id")
      .in("id", msgRefIds);
    const leadByMsg = new Map(
      (msgs ?? []).map((m) => [m.id as string, m.lead_id as string])
    );
    for (const a of rows) {
      if (a.ref_table === "messages" && a.ref_id) {
        const lead = leadByMsg.get(a.ref_id);
        if (lead) leadByAlert.set(a.id, lead);
      }
    }
  }

  if (draftRefIds.length > 0) {
    const { data: drs } = await supabase
      .from("drafts")
      .select("id, messages(lead_id)")
      .in("id", draftRefIds);
    for (const d of (drs ?? []) as Array<{
      id: string;
      messages: { lead_id: string } | { lead_id: string }[] | null;
    }>) {
      const m = Array.isArray(d.messages) ? d.messages[0] : d.messages;
      if (m?.lead_id) {
        const alert = rows.find(
          (a) => a.ref_table === "drafts" && a.ref_id === d.id
        );
        if (alert) leadByAlert.set(alert.id, m.lead_id);
      }
    }
  }

  const unackedCount = rows.filter((a) => !a.acknowledged_at).length;
  const criticalCount = rows.filter((a) => !a.acknowledged_at && a.severity === "critical").length;
  const warningCount = rows.filter((a) => !a.acknowledged_at && a.severity === "warning").length;

  return (
    <PageShell
      title="Alertas"
      description="El sistema se vigila solo y te avisa cuando algo necesita tu atención."
      actions={
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Link href={showAcked ? "/alerts" : "/alerts?show=all"}>
            <Button variant="secondary">
              {showAcked ? "Solo pendientes" : "Ver todas"}
            </Button>
          </Link>
          <AcknowledgeAllButton count={unackedCount} />
        </div>
      }
    >
      <AlertsRealtime />

      {/* KPI row */}
      <StatRow>
        <StatCard
          label="Sin ver"
          value={unackedCount}
          icon={<Bell size={18} />}
          tone={unackedCount > 0 ? "amber" : "default"}
        />
        <StatCard
          label="Urgentes"
          value={criticalCount}
          icon={<Alert size={18} />}
          tone={criticalCount > 0 ? "red" : "default"}
        />
        <StatCard
          label="Atención"
          value={warningCount}
          icon={<Check size={18} />}
          tone={warningCount > 0 ? "amber" : "emerald"}
        />
      </StatRow>

      {rows.length === 0 ? (
        <EmptyState
          title={showAcked ? "Sin alertas en el historial." : "Sin alertas pendientes."}
          description={showAcked ? undefined : "El sistema está funcionando correctamente."}
        />
      ) : (
        <div className="space-y-3">
          {rows.map((a) => {
            const link = linkFor(a, leadByAlert);
            return (
              <div
                key={a.id}
                className={
                  "rounded-xl border bg-white px-4 py-4 shadow-card transition-all duration-200 " +
                  (a.acknowledged_at
                    ? "border-neutral-200 opacity-60"
                    : "border-neutral-200 hover:shadow-pop hover:-translate-y-0.5 cursor-pointer")
                }
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <Badge color="neutral">
                        <span aria-hidden>{kindLabel(a.kind).icon}</span>{" "}
                        {kindLabel(a.kind).label}
                      </Badge>
                      {a.severity === "critical" && <Badge color="red">{severityMeta.critical.label}</Badge>}
                      {a.severity === "warning" && <Badge color="amber">{severityMeta.warning.label}</Badge>}
                      {a.severity === "info" && <Badge color="blue">{severityMeta.info.label}</Badge>}
                      <span className="text-xs text-neutral-400">{timeAgo(a.created_at)}</span>
                    </div>
                    <p className="text-sm font-medium text-neutral-900">{a.title}</p>
                    {a.description && (
                      <p className="mt-1 text-xs text-neutral-600 whitespace-pre-wrap">{a.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-row items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
                    {link && (
                      <Link
                        href={link}
                        className="text-xs font-medium text-brand hover:text-brand-strong transition-colors"
                      >
                        Ver →
                      </Link>
                    )}
                    {!a.acknowledged_at && <AcknowledgeButton alertId={a.id} />}
                    {a.acknowledged_at && (
                      <span className="text-xs text-neutral-400">Visto {timeAgo(a.acknowledged_at)}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
