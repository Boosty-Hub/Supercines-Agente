import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Button, PageShell, SectionCard, inputCls } from "@/components/ui";
import { KommoFieldSelect } from "@/components/kommo/field-select";
import { KommoConnectionCard } from "@/components/kommo/connection-card";
import { KommoWebhookPanel } from "@/components/kommo-webhook-panel";

export const dynamic = "force-dynamic";

// Sección única de Kommo. Reúne el cableado con Kommo que antes estaba disperso:
// conexión (subdominio + token), webhook entrante, publicación (campo destino +
// salesbot) y links al resto de la config de Kommo que vive donde se usa. El
// encendido/publicación/revisión del agente vive en Agente → "Encendido y
// publicación" (no se duplica acá).
export default async function KommoPage({
  searchParams,
}: {
  searchParams: { saved?: string };
}) {
  const supabase = createSupabaseServerClient();
  const [{ data: config }, { data: cred }] = await Promise.all([
    supabase
      .from("kommo_publish_config")
      .select("response_custom_field_id, salesbot_id")
      .eq("is_active", true)
      .single(),
    supabase
      .from("kommo_credentials")
      .select("subdomain, account_id, token_expires_at")
      .eq("is_active", true)
      .maybeSingle(),
  ]);

  const saved = searchParams.saved === "1";

  return (
    <PageShell
      title="Kommo"
      description="Todo el cableado con Kommo en un solo lugar: el webhook entrante y cómo publica el agente."
      width="narrow"
    >
      {saved && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          ✓ Configuración de Kommo guardada
        </div>
      )}

      {/* ── Conexión ────────────────────────────────────────────────────────── */}
      <KommoConnectionCard
        initialSubdomain={cred?.subdomain ?? ""}
        accountId={(cred?.account_id as number | null) ?? null}
        expiresAt={(cred?.token_expires_at as string | null) ?? null}
        connected={Boolean(cred?.subdomain)}
      />

      {/* ── Webhook ─────────────────────────────────────────────────────────── */}
      <KommoWebhookPanel />

      {/* ── Publicación ─────────────────────────────────────────────────────── */}
      <SectionCard
        title="Publicación Kommo"
        description="El campo del lead donde el agente deja cada respuesta y el salesbot que la envía."
      >
        <form action="/api/settings/kommo" method="post" className="space-y-5">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">
              Campo donde escribe el agente
            </label>
            <KommoFieldSelect
              name="response_custom_field_id"
              defaultValue={config?.response_custom_field_id ?? null}
            />
            <p className="text-xs text-neutral-500">
              Elegí el campo del lead (de tu cuenta Kommo) donde el agente deja cada respuesta. Si no aparece, creálo en Kommo como campo de texto largo y recargá.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">Salesbot ID</label>
            <input
              type="number"
              name="salesbot_id"
              defaultValue={config?.salesbot_id ?? ""}
              placeholder="78910"
              className={inputCls + " font-mono"}
            />
            <p className="text-xs text-neutral-500">
              Kommo no permite listar los bots por API, por eso va el número a mano: abrí tu bot en Kommo → Salesbot y copiá el número que aparece en la URL (…/salesbot/<span className="font-mono">12345</span>).
            </p>
          </div>

          <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
            El encendido del agente, el modo de publicación y la revisión humana se
            configuran en{" "}
            <a href="/agent" className="font-medium text-brand underline">
              Agente → Encendido y publicación
            </a>
            . Los límites por lead y filtros, en{" "}
            <a href="/agent?tab=filtros" className="font-medium text-brand underline">
              Agente → Comportamiento
            </a>
            .
          </p>

          <Button type="submit" variant="primary">Guardar</Button>
        </form>
      </SectionCard>

      {/* ── Más configuración de Kommo (hub de links, sin duplicar editores) ─── */}
      <SectionCard
        title="Más configuración de Kommo"
        description="El resto de lo que toca Kommo vive donde se usa. Desde acá llegás a todo."
      >
        <div className="divide-y divide-neutral-100">
          {[
            {
              href: "/agent?tab=filtros",
              title: "Embudos y etapas donde NO responde",
              desc: "Etapas de Kommo en las que el agente no contesta.",
            },
            {
              href: "/seguimiento",
              title: "Etapas y vendedores del seguimiento",
              desc: "Etapas donde SÍ corre el seguimiento y qué vendedores lo reciben.",
            },
            {
              href: "/agent",
              title: "Acciones en el CRM",
              desc: "Permitir que el agente mueva de etapa y complete campos en Kommo.",
            },
            {
              href: "/agent",
              title: "Comentarios de Instagram",
              desc: "Respuesta pública en comentarios (salesbot y campo propios).",
            },
          ].map((l) => (
            <a
              key={l.title + l.href}
              href={l.href}
              className="flex items-center justify-between gap-4 py-3 group"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-900 group-hover:text-brand">{l.title}</p>
                <p className="text-xs text-neutral-500">{l.desc}</p>
              </div>
              <span className="shrink-0 text-neutral-400 group-hover:text-brand">→</span>
            </a>
          ))}
        </div>
      </SectionCard>
    </PageShell>
  );
}
