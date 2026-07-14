"use client";

import { useState } from "react";
import { Switch, CapabilityCard } from "./action-ui";
import { useShopifyScopes, ShopifyScopesSummary } from "./shopify-scopes-badge";
import { capScopeStatus, type ShopifyCapKey } from "@/lib/shopify-scopes";

export type ShopifyFlags = {
  enabled: boolean; // master
  search: boolean;
  orders: boolean;
  checkout: boolean;
};

const FIELD: Record<keyof ShopifyFlags, string> = {
  enabled: "shopify_actions_enabled",
  search: "shopify_can_search",
  orders: "shopify_can_orders",
  checkout: "shopify_can_checkout",
};

export function ShopifyActionsPanel({
  initial,
  connected,
}: {
  initial: ShopifyFlags;
  connected: boolean;
}) {
  const [flags, setFlags] = useState<ShopifyFlags>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Permisos reales de la app (medidos en vivo) para avisar si se activa una
  // capacidad que la app no puede ejecutar.
  const scopesState = useShopifyScopes(connected);
  const granted = scopesState.scopes;

  // Aviso por capacidad: ⛔ activada sin permiso (va a fallar) o ⚠ falta para activar.
  function CapWarning({ cap }: { cap: ShopifyCapKey }) {
    if (granted === null) return null; // aún no medido / error → no alarmar
    const { missingRequired, missingRecommended } = capScopeStatus(cap, granted);
    const enabled = flags[cap];
    if (missingRequired.length > 0) {
      return (
        <p
          className={`mt-1 rounded-lg px-3 py-1.5 text-[11px] ${
            enabled ? "bg-red-50 text-red-700 font-medium" : "bg-amber-50 text-amber-700"
          }`}
        >
          {enabled ? "⛔ Activada, pero" : "⚠ Para activarla,"} la app de Shopify necesita el permiso{" "}
          <span className="font-mono">{missingRequired.join(", ")}</span>
          {enabled ? " — esta acción va a FALLAR hasta que lo agregues." : "."}
        </p>
      );
    }
    if (enabled && missingRecommended.length > 0) {
      return (
        <p className="mt-1 rounded-lg bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
          ⚠ Recomendado: agregá <span className="font-mono">{missingRecommended.join(", ")}</span>{" "}
          para datos más completos (ej. stock por talla).
        </p>
      );
    }
    return null;
  }

  async function persist(patch: Record<string, boolean>, optimistic: ShopifyFlags) {
    const prev = flags;
    setFlags(optimistic);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/shopify-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setFlags(prev);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleMaster(v: boolean) {
    const next: ShopifyFlags = v
      ? { ...flags, enabled: true }
      : { enabled: false, search: false, orders: false, checkout: false };
    const patch: Record<string, boolean> = v
      ? { shopify_actions_enabled: true }
      : {
          shopify_actions_enabled: false,
          shopify_can_search: false,
          shopify_can_orders: false,
          shopify_can_checkout: false,
        };
    persist(patch, next);
  }

  function toggleCap(key: keyof ShopifyFlags, v: boolean) {
    persist({ [FIELD[key]]: v }, { ...flags, [key]: v });
  }

  const capsDisabled = !connected || !flags.enabled || busy;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
              🛍️ Tienda Shopify
            </h2>
            <p className="text-xs text-neutral-500">
              Con esto el agente puede consultar el catálogo y vender desde el chat: buscar
              productos por nombre/categoría/talla, ver pedidos y armar links de pago. Solo actúa
              cuando se lo indicás.
            </p>
          </div>
          <Switch checked={flags.enabled} disabled={!connected || busy} onChange={toggleMaster} />
        </div>

        {!connected ? (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            ⚠️ Shopify no está conectado. Conectá la tienda en{" "}
            <a href="/settings" className="font-medium underline">
              Configuración
            </a>{" "}
            (pegás el dominio y el token) y después activás las capacidades acá.
          </p>
        ) : (
          !flags.enabled && (
            <p className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
              🔒 Apagado. El agente no consulta ni vende en Shopify hasta que lo actives.
            </p>
          )
        )}
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      </div>

      {/* Permisos reales de la app — la guarda contra activar tools sin permiso */}
      {connected && flags.enabled && <ShopifyScopesSummary state={scopesState} />}

      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          ¿Qué puede hacer?
        </p>
        <div>
          <CapabilityCard
            icon="🔎"
            title="Buscar productos y stock"
            description="Responde «¿tenés zapatos de niña talla 30? ¿cuánto salen?» con precio, variantes y disponibilidad reales. Incluye «los más vendidos» y ver categorías."
            checked={flags.search}
            disabled={capsDisabled}
            onChange={(v) => toggleCap("search", v)}
          />
          {connected && flags.enabled && <CapWarning cap="search" />}
        </div>
        <div>
          <CapabilityCard
            icon="📦"
            title="Consultar estado de pedidos"
            description="Responde «¿dónde está mi pedido?» por número de orden o email/teléfono, con estado y seguimiento."
            checked={flags.orders}
            disabled={capsDisabled}
            onChange={(v) => toggleCap("orders", v)}
          />
          {connected && flags.enabled && <CapWarning cap="orders" />}
        </div>
        <div>
          <CapabilityCard
            icon="💳"
            title="Crear link de pago"
            description="Arma un borrador de pedido con el producto/variante elegidos y manda el link de checkout para cerrar la venta en el chat."
            checked={flags.checkout}
            disabled={capsDisabled}
            onChange={(v) => toggleCap("checkout", v)}
          />
          {connected && flags.enabled && <CapWarning cap="checkout" />}
        </div>
      </div>

      <div className="space-y-2 rounded-xl border border-violet-200 bg-violet-50 p-4">
        <p className="text-xs font-medium text-neutral-700">✨ Cómo le decís cuándo usarlo</p>
        <p className="text-xs text-neutral-600">
          Igual que las acciones de CRM: lo escribís en la voz del agente o en una vertical.
          Ejemplos:
        </p>
        <div className="space-y-1.5 pt-1">
          {[
            "Si preguntan por un producto, buscalo en la tienda y pasá precio, tallas disponibles y el link.",
            "Si piden «lo más vendido», traé los más vendidos.",
            "Si quieren comprar, generales el link de pago del producto y la talla que eligieron.",
            "Si preguntan por su pedido, consultá el estado por su número o email.",
          ].map((ej) => (
            <p
              key={ej}
              className="rounded-lg border border-violet-200 bg-white px-3 py-2 text-xs text-neutral-700"
            >
              “{ej}”
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
