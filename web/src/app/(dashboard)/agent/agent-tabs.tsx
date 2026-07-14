"use client";

import { useState } from "react";
import {
  FiltersPanel,
  type Rule,
  type Limits,
  type VerticalLite,
  type ChannelsData,
  type MediaFlags,
} from "./filters-panel";
import { CrmActionsPanel, type CrmFlags } from "./crm-actions-panel";
import { ShopifyActionsPanel, type ShopifyFlags } from "./shopify-actions-panel";
import { BcvPanel } from "./bcv-panel";
import { BusinessHoursPanel, type BusinessHours } from "./business-hours-panel";
import { CommentsPanel, type CommentsConfig } from "./comments-panel";

type Tab = "identidad" | "filtros" | "acciones";

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-3 py-1.5 text-sm font-medium rounded-md transition-colors " +
        (active
          ? "bg-white text-neutral-900 shadow-sm"
          : "text-neutral-600 hover:text-neutral-900")
      }
    >
      {children}
    </button>
  );
}

export function AgentTabs({
  initialTab,
  rules,
  limits,
  verticals,
  channels,
  ignoredStageIds,
  debounce,
  freshness,
  media,
  crm,
  shopify,
  shopifyConnected,
  bcvEnabled,
  bcvHasCustomSource,
  businessHours,
  comments,
  hasOpenaiKey = false,
  children,
}: {
  initialTab: Tab;
  rules: Rule[];
  limits: Limits;
  verticals: VerticalLite[];
  channels: ChannelsData;
  ignoredStageIds: number[];
  debounce: number;
  freshness: number;
  media: MediaFlags;
  crm: CrmFlags;
  shopify: ShopifyFlags;
  shopifyConnected: boolean;
  bcvEnabled: boolean;
  bcvHasCustomSource: boolean;
  businessHours: BusinessHours | null;
  comments: CommentsConfig;
  hasOpenaiKey?: boolean;
  children: React.ReactNode; // panel de Identidad (server-rendered)
}) {
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <div className="space-y-6">
      {/* Segmented control tabs */}
      <div className="inline-flex gap-1 rounded-lg bg-neutral-100 p-1">
        <TabBtn active={tab === "identidad"} onClick={() => setTab("identidad")}>
          Identidad
        </TabBtn>
        <TabBtn active={tab === "filtros"} onClick={() => setTab("filtros")}>
          Comportamiento
        </TabBtn>
        <TabBtn active={tab === "acciones"} onClick={() => setTab("acciones")}>
          Acciones
        </TabBtn>
      </div>

      {/* Identidad: se mantiene montada (CSS hidden) para no perder ediciones del form */}
      <div className={tab === "identidad" ? "" : "hidden"}>{children}</div>

      {tab === "filtros" && (
        <div className="space-y-6">
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
      )}

      {tab === "acciones" && (
        <div className="space-y-6">
          <CrmActionsPanel initial={crm} />
          <ShopifyActionsPanel initial={shopify} connected={shopifyConnected} />
          <BcvPanel initialEnabled={bcvEnabled} hasCustomSource={bcvHasCustomSource} />
          <CommentsPanel initial={comments} />
        </div>
      )}
    </div>
  );
}
