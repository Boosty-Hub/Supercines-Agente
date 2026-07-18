// Webhook de alertas (Ajustes → Sistema). Extraído de la vieja settings/page.tsx
// para que la página unificada quede legible: ahora solo compone secciones.

import { Button, SectionCard, inputCls } from "@/components/ui";

export function AlertsForm({
  webhookUrl,
  enabled,
}: {
  webhookUrl: string;
  enabled: boolean;
}) {
  return (
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
            defaultValue={webhookUrl}
            placeholder="https://hooks.slack.com/services/... o https://discord.com/api/webhooks/..."
            className={inputCls + " font-mono"}
          />
          <p className="text-xs text-neutral-500">
            Compatible con Slack (campo &quot;text&quot;) y Discord (campo &quot;embeds&quot;).
            Para email, usá un Zap entrante.
          </p>
        </div>
        <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              name="webhook_enabled"
              defaultChecked={enabled}
              className="h-5 w-5 rounded border-neutral-300 text-brand focus:ring-brand"
            />
            <span className="font-medium text-neutral-900">Webhook habilitado</span>
          </label>
        </div>
        <Button type="submit" variant="primary">
          Guardar
        </Button>
      </form>
    </SectionCard>
  );
}
