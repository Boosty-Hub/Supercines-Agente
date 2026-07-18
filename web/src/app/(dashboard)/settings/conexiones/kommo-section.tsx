// Sección Kommo dentro de Ajustes → Conexiones.
//
// Viene de la página suelta /config/kommo. Se eliminó su "hub de links" (4
// enlaces que apuntaban a /agent y a /seguimiento) y el párrafo que remitía a
// "Agente → Encendido y publicación": ahora todo eso vive en las pestañas de
// esta misma página, así que los enlaces cruzados no tienen sentido.

import { Button, SectionCard, inputCls } from "@/components/ui";
import { KommoFieldSelect } from "@/components/kommo/field-select";
import { KommoConnectionCard } from "@/components/kommo/connection-card";
import { KommoWebhookPanel } from "@/components/kommo/webhook-panel";

export type KommoSectionData = {
  credentials: {
    subdomain: string | null;
    accountId: number | null;
    expiresAt: string | null;
  };
  publish: {
    responseFieldId: number | null;
    salesbotId: number | null;
  };
};

export function KommoSection({ data }: { data: KommoSectionData }) {
  const { credentials, publish } = data;

  return (
    <div className="space-y-4">
      <KommoConnectionCard
        initialSubdomain={credentials.subdomain ?? ""}
        accountId={credentials.accountId}
        expiresAt={credentials.expiresAt}
        connected={Boolean(credentials.subdomain)}
      />

      <KommoWebhookPanel />

      <SectionCard
        title="Publicación en Kommo"
        description="El campo del lead donde el agente deja cada respuesta y el salesbot que la envía."
      >
        <form action="/api/settings/kommo" method="post" className="space-y-5">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">
              Campo donde escribe el agente
            </label>
            <KommoFieldSelect
              name="response_custom_field_id"
              defaultValue={publish.responseFieldId}
            />
            <p className="text-xs text-neutral-500">
              Elegí el campo del lead (de tu cuenta Kommo) donde el agente deja cada
              respuesta. Si no aparece, creálo en Kommo como campo de texto largo y
              recargá.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">Salesbot ID</label>
            <input
              type="number"
              name="salesbot_id"
              defaultValue={publish.salesbotId ?? ""}
              placeholder="78910"
              className={inputCls + " font-mono"}
            />
            <p className="text-xs text-neutral-500">
              Kommo no permite listar los bots por API, por eso va el número a mano: abrí
              tu bot en Kommo → Salesbot y copiá el número que aparece en la URL
              (…/salesbot/<span className="font-mono">12345</span>).
            </p>
          </div>

          <Button type="submit" variant="primary">
            Guardar
          </Button>
        </form>
      </SectionCard>
    </div>
  );
}
