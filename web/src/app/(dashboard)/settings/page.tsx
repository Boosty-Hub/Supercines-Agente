// Ajustes — el único módulo de configuración.
//
// Absorbió las páginas sueltas /agent, /config/kommo y /tools. Antes eran tres
// cascadas de queries independientes (y dos SELECT distintos a la MISMA fila de
// kommo_publish_config). Acá se hace un
// solo Promise.all y los datos se reparten a las cuatro pestañas.

import { headers } from "next/headers";
import { configValues } from "@/lib/runtime-config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Badge, PageShell, SectionCard } from "@/components/ui";
import { toReviewMode } from "@/lib/review-mode";

import { SettingsTabs, type SettingsTab } from "./settings-tabs";
import { AgenteTab, type AgenteSection } from "./agente/agente-tab";
import { AgentForm } from "./agente/agent-form";
import { AgentPublishPanel, type PublishState } from "./agente/agent-publish-panel";
import type { Rule, VerticalLite } from "./agente/filters-panel";
import type { CommentsConfig } from "./agente/comments-panel";
import { KommoSection } from "./conexiones/kommo-section";
import { ToolEditor, type AgentTool } from "./herramientas/tool-editor";
import { EmbedCodePanel } from "./embed-code-panel";
import { AlertsForm } from "./sistema/alerts-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: {
    tab?: string;
    sec?: string;
    saved?: string;
    sync?: string;
    error?: string;
    alerts_saved?: string;
  };
}) {
  const cfg = await configValues([
    "SYSTEM_PROMPT",
    "OPERATOR_NAME",
    "AGENT_NAME",
    "NEXT_PUBLIC_AGENT_LABEL",
    "ANTHROPIC_AGENT_ID",
    "ANTHROPIC_AGENT_VERSION",
    "BCV_RATE_URL",
    "OPENAI_API_KEY",
  ]);

  const supabase = createSupabaseServerClient();
  const [rulesRes, pubRes, vertRes, seenRes, fuRes, credRes, alertRes, toolsRes] =
    await Promise.all([
      supabase
        .from("agent_skip_rules")
        .select("id, pattern, match_type, case_sensitive, enabled, description")
        .order("created_at", { ascending: true }),
      // Fila singleton de configuración: un solo SELECT para toda la página
      // (antes /agent pedía 40 columnas y /config/kommo repetía la consulta
      // para pedir otras 2).
      supabase
        .from("kommo_publish_config")
        .select(
          "response_cooldown_seconds, max_responses_per_lead, cooldown_window_hours, ignored_channels, ignored_stage_ids, response_debounce_seconds, answer_max_age_hours, respond_to_images, respond_to_documents, respond_to_audio, agent_off_field_id, agent_off_field_name, crm_actions_enabled, crm_can_move_stage, crm_can_update_lead, crm_can_update_contact, bcv_rate_enabled, respond_to_comments, comment_reply_enabled, comment_salesbot_id, comment_field_id, comment_reply_rules, comment_instructions, comment_source_ids, agent_enabled, publishing_enabled, bypass_review, auto_reply_mode, response_custom_field_id, salesbot_id"
        )
        .eq("is_active", true)
        .maybeSingle(),
      supabase.from("verticals").select("id, slug, name, ignore").order("slug"),
      // Canales realmente vistos en mensajes (para mostrarlos como opciones).
      supabase.from("messages").select("source").not("source", "is", null).limit(1000),
      // Horario laboral (single source of truth compartida con Seguimiento).
      supabase
        .from("follow_up_config")
        .select("timezone, business_hours, business_hours_start, business_hours_end, active_days")
        .eq("is_active", true)
        .maybeSingle(),
      supabase
        .from("kommo_credentials")
        .select("subdomain, account_id, token_expires_at")
        .eq("is_active", true)
        .maybeSingle(),
      supabase
        .from("alert_config")
        .select("webhook_url, webhook_enabled")
        .eq("is_active", true)
        .maybeSingle(),
      supabase
        .from("agent_tools")
        .select("*")
        .order("tool_type", { ascending: false }) // 'system' > 'http'
        .order("created_at", { ascending: true }),
    ]);

  const p = pubRes.data;

  // ── Datos: pestaña Agente ─────────────────────────────────────────────────
  const rules = (rulesRes.data ?? []) as Rule[];
  const verticals = (vertRes.data ?? []) as VerticalLite[];
  const limits = {
    cooldown: p?.response_cooldown_seconds ?? 0,
    max: p?.max_responses_per_lead ?? 0,
    window: p?.cooldown_window_hours ?? 24,
  };
  const channels = {
    seen: Array.from(
      new Set(
        ((seenRes.data ?? []) as { source: string | null }[])
          .map((m) => m.source)
          .filter((s): s is string => Boolean(s))
      )
    ),
    ignored: (p?.ignored_channels ?? []) as string[],
  };
  const media = {
    images: p?.respond_to_images === true,
    documents: p?.respond_to_documents === true,
    audio: p?.respond_to_audio === true,
  };
  const publish: PublishState = {
    agentEnabled: p?.agent_enabled !== false, // default ON
    publishing: p?.publishing_enabled === true,
    reviewMode: toReviewMode({
      publishing_enabled: p?.publishing_enabled === true,
      bypass_review: p?.bypass_review === true,
      auto_reply_mode: (p?.auto_reply_mode as string | null) ?? null,
    }),
  };
  const crm = {
    enabled: p?.crm_actions_enabled === true,
    moveStage: p?.crm_can_move_stage === true,
    updateLead: p?.crm_can_update_lead === true,
    updateContact: p?.crm_can_update_contact === true,
  };
  const comments: CommentsConfig = {
    respond_to_comments: p?.respond_to_comments === true,
    comment_reply_enabled: p?.comment_reply_enabled === true,
    comment_salesbot_id: (p?.comment_salesbot_id as number | null) ?? null,
    comment_field_id: (p?.comment_field_id as number | null) ?? null,
    comment_reply_rules: (p?.comment_reply_rules as string | null) ?? null,
    comment_instructions: (p?.comment_instructions as string | null) ?? null,
    comment_source_ids: ((p?.comment_source_ids ?? []) as number[]).map(Number),
  };

  // ── Datos: pestaña Herramientas ───────────────────────────────────────────
  const tools = (toolsRes.data ?? []) as AgentTool[];
  const enabledHttpCount = tools.filter((t) => t.tool_type === "http" && t.enabled).length;

  // ── Datos: pestaña Sistema ────────────────────────────────────────────────
  const host = headers().get("host") ?? "tu-dominio.com";
  const proto = headers().get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const baseUrl = `${proto}://${host}`;

  // ── Estado de la vista ────────────────────────────────────────────────────
  const provisioned = Boolean(cfg.ANTHROPIC_AGENT_ID);
  const saved = searchParams.saved === "1" || searchParams.alerts_saved === "1";
  const sync = searchParams.sync;
  const errorMsg = searchParams.error;

  const initialTab: SettingsTab =
    searchParams.tab === "conexiones"
      ? "conexiones"
      : searchParams.tab === "herramientas"
        ? "herramientas"
        : searchParams.tab === "sistema" || searchParams.alerts_saved === "1"
          ? "sistema"
          : "agente";

  const initialSection: AgenteSection =
    searchParams.sec === "filtros"
      ? "filtros"
      : searchParams.sec === "acciones"
        ? "acciones"
        : "identidad";

  return (
    <PageShell
      title="Ajustes"
      description="Todo lo que configura al agente: su identidad y comportamiento, las conexiones, sus herramientas y el sistema."
    >
      {/* Un solo banner de guardado para toda la página (antes había tres, uno
          por módulo, con tres flags distintos de querystring). */}
      {saved && sync === "ok" && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          ✓ Guardado y sincronizado con Anthropic
          {cfg.ANTHROPIC_AGENT_VERSION ? ` (v${cfg.ANTHROPIC_AGENT_VERSION})` : ""}.
        </div>
      )}
      {saved && sync === "pending" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ✓ Guardado en la plataforma. El agente todavía NO está aprovisionado —
          completá el <a className="font-medium underline" href="/setup">setup</a> para
          crearlo en Anthropic con este prompt.
        </div>
      )}
      {saved && sync === "error" && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          ✓ Guardado en la plataforma, pero la sincronización con Anthropic falló:{" "}
          <span className="font-mono">{errorMsg}</span>
        </div>
      )}
      {saved && !sync && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          ✓ Configuración guardada
        </div>
      )}
      {!saved && errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          ✗ {errorMsg}
        </div>
      )}

      <SettingsTabs
        initialTab={initialTab}
        // ── Agente ────────────────────────────────────────────────────────
        agente={
          <AgenteTab
            initialSection={initialSection}
            rules={rules}
            limits={limits}
            verticals={verticals}
            channels={channels}
            ignoredStageIds={(p?.ignored_stage_ids ?? []) as number[]}
            debounce={(p?.response_debounce_seconds ?? 45) as number}
            freshness={(p?.answer_max_age_hours ?? 1) as number}
            media={media}
            hasOpenaiKey={Boolean(cfg.OPENAI_API_KEY)}
            crm={crm}
            bcvEnabled={p?.bcv_rate_enabled === true}
            bcvHasCustomSource={Boolean(cfg.BCV_RATE_URL)}
            businessHours={fuRes.data ?? null}
            comments={comments}
          >
            <div className="space-y-6">
              <AgentPublishPanel
                initial={publish}
                agentOff={{
                  fieldId: (p?.agent_off_field_id as number | null) ?? null,
                  fieldName: (p?.agent_off_field_name as string | null) ?? null,
                }}
              />

              <SectionCard
                title="Estado en Anthropic"
                action={
                  <Badge color={provisioned ? "green" : "amber"}>
                    {provisioned ? "Aprovisionado" : "Pendiente"}
                  </Badge>
                }
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-neutral-500">Agent ID</p>
                    <p className="mt-1 break-all font-mono text-xs text-neutral-900">
                      {cfg.ANTHROPIC_AGENT_ID ?? "(no configurado — corré /setup)"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-neutral-500">Versión</p>
                    <p className="mt-1 font-mono text-sm text-neutral-900">
                      {cfg.ANTHROPIC_AGENT_VERSION ? `v${cfg.ANTHROPIC_AGENT_VERSION}` : "—"}
                    </p>
                  </div>
                </div>
              </SectionCard>

              <AgentForm
                initial={{
                  operatorName: cfg.OPERATOR_NAME ?? "",
                  agentName: cfg.AGENT_NAME ?? "",
                  agentLabel: cfg.NEXT_PUBLIC_AGENT_LABEL ?? "",
                  systemPrompt: cfg.SYSTEM_PROMPT ?? "",
                }}
              />
            </div>
          </AgenteTab>
        }
        // ── Conexiones ────────────────────────────────────────────────────
        conexiones={
          <div className="space-y-4">
            <KommoSection
              data={{
                credentials: {
                  subdomain: (credRes.data?.subdomain as string | null) ?? null,
                  accountId: (credRes.data?.account_id as number | null) ?? null,
                  expiresAt: (credRes.data?.token_expires_at as string | null) ?? null,
                },
                publish: {
                  responseFieldId: (p?.response_custom_field_id as number | null) ?? null,
                  salesbotId: (p?.salesbot_id as number | null) ?? null,
                },
              }}
            />
          </div>
        }
        // ── Herramientas ──────────────────────────────────────────────────
        herramientas={<ToolEditor tools={tools} enabledHttpCount={enabledHttpCount} />}
        // ── Sistema ───────────────────────────────────────────────────────
        sistema={
          <div className="space-y-4">
            <AlertsForm
              webhookUrl={(alertRes.data?.webhook_url as string | null) ?? ""}
              enabled={alertRes.data?.webhook_enabled === true}
            />
            <SectionCard
              title="Integrar en tu app"
              description="Embebé el dashboard dentro de cualquier app existente con una sola línea de código."
            >
              <EmbedCodePanel baseUrl={baseUrl} />
            </SectionCard>
          </div>
        }
      />
    </PageShell>
  );
}
