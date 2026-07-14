import { headers } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue } from "@/lib/runtime-config";
import { getShopifyStatus } from "@/lib/shopify";
import { Button, PageShell, SectionCard, inputCls } from "@/components/ui";
import { UpdatesPanel } from "./updates-panel";
import { ShopifyConnect } from "./shopify-connect";
import { SettingsTabs, type SettingsTab } from "./settings-tabs";
import { EmbedCodePanel } from "./embed-code-panel";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { alerts_saved?: string; tab?: string };
}) {
  const supabase = createSupabaseServerClient();
  const { data: alertCfg } = await supabase
    .from("alert_config")
    .select("webhook_url, webhook_enabled")
    .eq("is_active", true)
    .single();

  const shopifyStatus = await getShopifyStatus();
  const autoUpdateEnabled = (await configValue("AUTO_UPDATE_ENABLED")) !== "0";

  // URL base del panel — se detecta automáticamente, sin variable de entorno
  const host = headers().get("host") ?? "tu-dominio.com";
  const proto = headers().get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const baseUrl = `${proto}://${host}`;

  const alertsSaved = searchParams.alerts_saved === "1";

  // Pestaña inicial: tras guardar alertas caemos en Sistema para ver la
  // confirmación; si no, respetamos ?tab.
  const initialTab: SettingsTab =
    alertsSaved || searchParams.tab === "sistema"
      ? "sistema"
      : searchParams.tab === "integrar"
        ? "integrar"
        : "conexiones";

  // ── Slot: Conexiones ──────────────────────────────────────────────────────
  const conexiones = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <ShopifyConnect connected={shopifyStatus.configured} domain={shopifyStatus.domain} />
    </div>
  );

  // ── Slot: Integrar ───────────────────────────────────────────────────────
  const integrar = (
    <SectionCard
      title="Integrar en tu app"
      description="Embebé el dashboard dentro de cualquier app existente con una sola línea de código."
    >
      <EmbedCodePanel baseUrl={baseUrl} />
    </SectionCard>
  );

  // ── Slot: Sistema ─────────────────────────────────────────────────────────
  const sistema = (
    <div className="space-y-4">
      {alertsSaved && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          ✓ Configuración de alertas guardada
        </div>
      )}

      <UpdatesPanel autoUpdateEnabled={autoUpdateEnabled} />

      <SectionCard
        title="Alertas"
        description="Webhook opcional para recibir alertas en Slack/Discord/Zapier."
      >
        <form action="/api/settings/alerts" method="post" className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">Webhook URL</label>
            <input
              type="url"
              name="webhook_url"
              defaultValue={alertCfg?.webhook_url ?? ""}
              placeholder="https://hooks.slack.com/services/... o https://discord.com/api/webhooks/..."
              className={inputCls + " font-mono"}
            />
            <p className="text-xs text-neutral-500">
              Compatible con Slack (campo &quot;text&quot;) y Discord (campo &quot;embeds&quot;). Para email, usá un Zap entrante.
            </p>
          </div>
          <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="webhook_enabled"
                defaultChecked={alertCfg?.webhook_enabled ?? false}
                className="h-5 w-5 rounded border-neutral-300 text-brand focus:ring-brand"
              />
              <span className="font-medium text-neutral-900">Webhook habilitado</span>
            </label>
          </div>
          <Button type="submit" variant="primary">Guardar</Button>
        </form>
      </SectionCard>
    </div>
  );

  return (
    <PageShell title="Ajustes" width="narrow">
      <SettingsTabs
        initialTab={initialTab}
        conexiones={conexiones}
        sistema={sistema}
        integrar={integrar}
      />
    </PageShell>
  );
}
