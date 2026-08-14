"use client";

// Pestaña "Agente" dentro de Ajustes. Reemplaza a la vieja página /agent y a su
// componente AgentTabs (borrado): la barra de pestañas ahora es el
// SegmentedControl canónico de @/components/ui.
//
// Tres sub-secciones para que ninguna pantalla quede kilométrica. Los enlaces
// viejos /agent?tab=filtros y /agent?tab=acciones entran acá como
// /settings?tab=agente&sec=filtros|acciones.

import { useState } from "react";
import { SegmentedControl } from "@/components/ui";
import { FiltersPanel, type Rule, type Limits, type VerticalLite, type ChannelsData, type MediaFlags } from "./filters-panel";
import { CrmActionsPanel, type CrmFlags } from "./crm-actions-panel";
import { BcvPanel } from "./bcv-panel";
import { BusinessHoursPanel, type BusinessHours } from "./business-hours-panel";
import { CommentsPanel, type CommentsConfig } from "./comments-panel";
import { RoutingPanel, type Assignee, type RoutingConfig } from "./routing-panel";

export type AgenteSection = "identidad" | "filtros" | "acciones";

const SECTIONS: { id: AgenteSection; label: string }[] = [
  { id: "identidad", label: "Identidad" },
  { id: "filtros", label: "Comportamiento" },
  { id: "acciones", label: "Acciones" },
];

export function AgenteTab({
  initialSection,
  rules,
  limits,
  verticals,
  channels,
  ignoredStageIds,
  debounce,
  freshness,
  media,
  crm,
  bcvEnabled,
  bcvHasCustomSource,
  businessHours,
  comments,
  routing,
  assignees,
  hasOpenaiKey = false,
  children,
}: {
  initialSection: AgenteSection;
  rules: Rule[];
  limits: Limits;
  verticals: VerticalLite[];
  channels: ChannelsData;
  ignoredStageIds: number[];
  debounce: number;
  freshness: number;
  media: MediaFlags;
  crm: CrmFlags;
  bcvEnabled: boolean;
  bcvHasCustomSource: boolean;
  businessHours: BusinessHours | null;
  comments: CommentsConfig;
  routing: RoutingConfig;
  assignees: Assignee[];
  hasOpenaiKey?: boolean;
  /** Panel de Identidad (server-rendered: encendido, estado Anthropic, prompt). */
  children: React.ReactNode;
}) {
  const [sec, setSec] = useState<AgenteSection>(initialSection);

  return (
    <div className="space-y-6">
      <SegmentedControl
        items={SECTIONS}
        value={sec}
        onChange={setSec}
        size="sm"
        aria-label="Secciones del agente"
      />

      {/* Identidad se mantiene montada para no perder ediciones del prompt. */}
      <div className={sec === "identidad" ? "" : "hidden"}>{children}</div>

      <div className={sec === "filtros" ? "space-y-6" : "hidden"}>
        <BusinessHoursPanel initial={businessHours} />
        <FiltersPanel
          freshness={freshness}
          rules={rules}
          limits={limits}
          verticals={verticals}
          channels={channels}
          ignoredStageIds={ignoredStageIds}
          debounce={debounce}
          media={media}
          hasOpenaiKey={hasOpenaiKey}
        />
      </div>

      <div className={sec === "acciones" ? "space-y-6" : "hidden"}>
        <CrmActionsPanel initial={crm} />
        <RoutingPanel initialConfig={routing} initialAssignees={assignees} />
        <BcvPanel initialEnabled={bcvEnabled} hasCustomSource={bcvHasCustomSource} />
        <CommentsPanel initial={comments} />
      </div>
    </div>
  );
}
