"use client";

// Pestañas de Ajustes — el único módulo de configuración del dashboard.
//
// Absorbió las páginas sueltas /agent, /config/kommo y /tools. Cada slot se
// renderiza en el server (forms con action=, datos de Supabase) y llega como
// prop; acá solo se decide cuál se muestra.
//
// Los cuatro slots quedan MONTADOS (ocultos con CSS) para no perder lo tipeado
// al cambiar de pestaña. Eso es seguro porque los fetches de cliente
// (/api/kommo/fields, /api/shopify/scopes) están cacheados a nivel de módulo:
// se piden una vez por carga de página, no una vez por panel.

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SegmentedControl } from "@/components/ui";

export type SettingsTab = "agente" | "conexiones" | "herramientas" | "sistema";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "agente", label: "Agente" },
  { id: "conexiones", label: "Conexiones" },
  { id: "herramientas", label: "Herramientas" },
  { id: "sistema", label: "Sistema" },
];

const IS_TAB = (v: string | null): v is SettingsTab =>
  v === "agente" || v === "conexiones" || v === "herramientas" || v === "sistema";

export function SettingsTabs({
  initialTab,
  agente,
  conexiones,
  herramientas,
  sistema,
}: {
  initialTab: SettingsTab;
  agente: React.ReactNode;
  conexiones: React.ReactNode;
  herramientas: React.ReactNode;
  sistema: React.ReactNode;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const router = useRouter();
  const params = useSearchParams();

  // Enlaces entrantes (?tab=...) desde otros módulos y desde las rutas viejas
  // que ahora redirigen acá.
  const urlTab = params.get("tab");
  useEffect(() => {
    if (IS_TAB(urlTab) && urlTab !== tab) setTab(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  function select(next: SettingsTab) {
    setTab(next);
    // Reflejar la pestaña en la URL sin recargar, para que sea compartible y
    // para que el botón "atrás" funcione como se espera.
    const qs = new URLSearchParams(Array.from(params.entries()));
    qs.set("tab", next);
    qs.delete("sec"); // el ancla de sección solo aplica a la carga inicial
    router.replace(`/settings?${qs.toString()}`, { scroll: false });
  }

  const slots: Record<SettingsTab, React.ReactNode> = {
    agente,
    conexiones,
    herramientas,
    sistema,
  };

  return (
    <div className="space-y-6">
      <SegmentedControl
        items={TABS}
        value={tab}
        onChange={select}
        aria-label="Secciones de Ajustes"
      />
      {TABS.map((t) => (
        <div key={t.id} className={tab === t.id ? "" : "hidden"}>
          {slots[t.id]}
        </div>
      ))}
    </div>
  );
}
