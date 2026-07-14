"use client";

// Pestañas de Configuración (segmented control), mismo patrón que /agent.
// Reemplaza el scroll vertical largo de grupos: cada grupo vive en su pestaña.
// El contenido de cada slot se renderiza en el server (forms con action=, datos
// de Supabase) y se pasa como prop; acá solo alternamos cuál se muestra.
// Se mantienen los tres montados (CSS hidden) para no perder lo tipeado en los
// forms al cambiar de pestaña.

import { useState } from "react";

export type SettingsTab = "conexiones" | "sistema" | "integrar";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "conexiones", label: "Conexiones" },
  { id: "sistema", label: "Sistema" },
  { id: "integrar", label: "Integrar" },
];

export function SettingsTabs({
  initialTab,
  conexiones,
  sistema,
  integrar,
}: {
  initialTab: SettingsTab;
  conexiones: React.ReactNode;
  sistema: React.ReactNode;
  integrar: React.ReactNode;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  return (
    <div className="space-y-6">
      <div className="inline-flex gap-1 rounded-lg bg-neutral-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
              (tab === t.id
                ? "bg-white text-neutral-900 shadow-sm"
                : "text-neutral-600 hover:text-neutral-900")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={tab === "conexiones" ? "" : "hidden"}>{conexiones}</div>
      <div className={tab === "sistema" ? "" : "hidden"}>{sistema}</div>
      <div className={tab === "integrar" ? "" : "hidden"}>{integrar}</div>
    </div>
  );
}
