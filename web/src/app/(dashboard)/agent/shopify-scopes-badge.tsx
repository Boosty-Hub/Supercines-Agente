"use client";

// Lector de permisos REALES de la app de Shopify. Hook compartido + dos vistas:
//   - <ShopifyScopesSummary>: resumen general (qué permisos tiene la app).
//   - useShopifyScopes(): para que el panel de Acciones avise por capacidad.
// Mide en vivo contra /api/shopify/scopes (dinámico por cliente).

import { useCallback, useEffect, useState } from "react";
import { ALL_SHOPIFY_SCOPES, SHOPIFY_CAP_SCOPES } from "@/lib/shopify-scopes";

export type ScopesState = {
  loading: boolean;
  scopes: string[] | null; // null = aún no medido / error
  error: string | null;
  shopName?: string;
  reload: () => void;
};

export function useShopifyScopes(enabled: boolean): ScopesState {
  const [loading, setLoading] = useState(false);
  const [scopes, setScopes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shopName, setShopName] = useState<string | undefined>();
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch("/api/shopify/scopes", { cache: "no-store" });
        const j = await res.json();
        if (cancelled) return;
        if (!j.ok) {
          setScopes(null);
          setError(j.error ?? "No se pudieron leer los permisos.");
        } else {
          setScopes(j.scopes ?? []);
          setShopName(j.shopName);
        }
      } catch (e) {
        if (!cancelled) {
          setScopes(null);
          setError(e instanceof Error ? e.message : "Error de red");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, nonce]);

  return { loading, scopes, error, shopName, reload };
}

const SCOPE_LABELS: Record<string, string> = {
  read_products: "Ver productos",
  read_inventory: "Ver stock",
  read_orders: "Ver pedidos",
  write_draft_orders: "Crear órdenes / links de pago",
  read_draft_orders: "Leer órdenes en borrador",
};

export function ShopifyScopesSummary({ state }: { state: ScopesState }) {
  const { loading, scopes, error, reload } = state;

  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-neutral-700">Permisos reales de la app</p>
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="text-[11px] font-medium text-neutral-500 underline disabled:opacity-40"
        >
          {loading ? "Verificando…" : "Volver a verificar"}
        </button>
      </div>

      {error ? (
        <p className="mt-2 text-xs text-amber-700">⚠ {error}</p>
      ) : scopes === null ? (
        <p className="mt-2 text-xs text-neutral-400">Leyendo permisos…</p>
      ) : (
        <div className="mt-2 space-y-1">
          {ALL_SHOPIFY_SCOPES.map((s) => {
            const has = scopes.includes(s);
            return (
              <div key={s} className="flex items-center gap-2 text-xs">
                <span>{has ? "✅" : "⚠"}</span>
                <span className={has ? "text-neutral-700" : "text-amber-700 font-medium"}>
                  {SCOPE_LABELS[s] ?? s}
                </span>
                <span className="font-mono text-[10px] text-neutral-400">{s}</span>
              </div>
            );
          })}
          <p className="pt-1 text-[10px] text-neutral-400">
            Si falta alguno, agregalo en los scopes de tu app de Shopify y reinstalala — esa acción
            del agente fallaría sin el permiso.
          </p>
        </div>
      )}
    </div>
  );
}

export { SHOPIFY_CAP_SCOPES };
