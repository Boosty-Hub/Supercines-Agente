// Webhook de alertas (Ajustes → Sistema). Extraído de la vieja settings/page.tsx
// para que la página unificada quede legible: ahora solo compone secciones.

import { Button, SectionCard, inputCls } from "@/components/ui";

// El valor actual del webhook (un secreto: quien lo tiene postea en el canal del operador)
// NUNCA llega al navegador: solo su versión enmascarada. Input vacío = conservar,
// «Quitar el webhook» = borrar, otro valor = reemplazar (api/settings/alerts).
export function AlertsForm({
  webhookMasked,
  enabled,
}: {
  webhookMasked: string | null;
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
          {webhookMasked && (
            <p className="text-xs text-neutral-600">
              Configurado: <span className="font-mono">{webhookMasked}</span>. Dejá el campo vacío para conservarlo.
            </p>
          )}
          <input
            type="url"
            name="webhook_url"
            defaultValue=""
            autoComplete="off"
            placeholder={
              webhookMasked
                ? "Pegá una URL nueva para reemplazarlo"
                : "https://hooks.slack.com/services/... o https://discord.com/api/webhooks/..."
            }
            className={inputCls + " font-mono"}
          />
          <p className="text-xs text-neutral-500">
            Compatible con Slack (campo &quot;text&quot;) y Discord (campo &quot;embeds&quot;).
            Para email, usá un Zap entrante.
          </p>
          {webhookMasked && (
            <label className="flex items-center gap-2 text-xs text-neutral-700">
              <input type="checkbox" name="webhook_clear" className="h-4 w-4 rounded border-neutral-300" />
              Quitar el webhook
            </label>
          )}
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
