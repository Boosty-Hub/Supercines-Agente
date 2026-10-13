import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell } from "@/components/ui";
import { TemplateEditor } from "./template-editor";
import { SequenceEditor } from "./sequence-editor";
import { ConfigPanel } from "./config-panel";
import { RecentSends, type RecentSend } from "./recent-sends";
import { Guide } from "./guide";

export const dynamic = "force-dynamic";

type FollowUpTemplate = {
  id: string;
  name: string;
  description: string | null;
  body: string;
  // Cada variable apunta directo a un campo de Kommo (sin tabla de mapeo intermedia).
  variables: Array<{
    name: string;
    description: string;
    kommo_field_id: number | null;
    kommo_field_name: string | null;
  }>;
  salesbot_id: number | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type FollowUpStep = {
  id: string;
  step_number: number;
  delay_hours: number;
  template_id: string | null;
  enabled: boolean;
};

type FollowUpConfig = {
  id: string;
  enabled: boolean;
  timezone: string;
  business_hours: Record<string, { start: string; end: string }> | null;
  business_hours_start: number;
  business_hours_end: number;
  active_days: number[];
  max_follow_ups: number;
  min_gap_hours: number;
  run_stage_ids: number[];
  run_user_ids: number[];
  notes: string | null;
};

type FollowUpSendRow = {
  id: string;
  lead_id: string;
  step: number;
  status: string;
  error: string | null;
  sent_at: string;
  leads: { display_name: string | null; kommo_lead_id: number | null } | { display_name: string | null; kommo_lead_id: number | null }[] | null;
  follow_up_templates: { name: string } | { name: string }[] | null;
};

export default async function SeguimientoPage() {
  const supabase = await createSupabaseServerClient();

  const [templatesRes, stepsRes, configRes, sendsRes] = await Promise.all([
    supabase
      .from("follow_up_templates")
      .select("id, name, description, body, variables, salesbot_id, enabled, created_at, updated_at")
      .order("name"),
    supabase
      .from("follow_up_steps")
      .select("id, step_number, delay_hours, template_id, enabled")
      .order("step_number"),
    supabase
      .from("follow_up_config")
      .select(
        "id, enabled, timezone, business_hours, business_hours_start, business_hours_end, active_days, max_follow_ups, min_gap_hours, run_stage_ids, run_user_ids, notes"
      )
      .eq("is_active", true)
      .maybeSingle(),
    // Log de envíos (tabla `follow_ups`, append-only) para la sección "Envíos
    // recientes" — 20 filas, no necesita fetchAllRows (no es un agregado).
    supabase
      .from("follow_ups")
      .select("id, lead_id, step, status, error, sent_at, leads(display_name, kommo_lead_id), follow_up_templates(name)")
      .order("sent_at", { ascending: false })
      .limit(20),
  ]);

  const templates = (templatesRes.data ?? []) as FollowUpTemplate[];
  const steps = (stepsRes.data ?? []) as FollowUpStep[];
  const config = configRes.data as FollowUpConfig | null;

  const recentSends: RecentSend[] = ((sendsRes.data ?? []) as FollowUpSendRow[]).map((s) => {
    const lead = Array.isArray(s.leads) ? s.leads[0] : s.leads;
    const template = Array.isArray(s.follow_up_templates) ? s.follow_up_templates[0] : s.follow_up_templates;
    return {
      id: s.id,
      leadId: s.lead_id,
      leadName: lead?.display_name ?? `Lead ${lead?.kommo_lead_id ?? "?"}`,
      step: s.step,
      status: s.status,
      sentAt: s.sent_at,
      templateName: template?.name ?? null,
      error: s.error,
    };
  });

  return (
    <PageShell
      title="Seguimiento automático"
      description="Configurá las plantillas de WhatsApp, la secuencia de pasos y los horarios de envío."
    >
      <Guide />
      <ConfigPanel config={config} />
      <TemplateEditor templates={templates} />
      <SequenceEditor steps={steps} templates={templates} />
      <RecentSends rows={recentSends} />
    </PageShell>
  );
}
