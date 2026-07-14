"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, ConfirmDialog, inputCls as sharedInputCls } from "@/components/ui";
import { useShopifyScopes, ShopifyScopesSummary } from "@/app/(dashboard)/agent/shopify-scopes-badge";

type Mode = "credentials" | "legacy";

export function ShopifyConnect({
  connected,
  domain,
}: {
  connected: boolean;
  domain: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(!connected);
  const [mode, setMode] = useState<Mode>("credentials");
  const [dom, setDom] = useState(domain ?? "");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  async function connect() {
    if (!dom.trim()) {
      setError("Completá el dominio de la tienda.");
      return;
    }
    if (mode === "credentials" && (!clientId.trim() || !clientSecret.trim())) {
      setError("Completá el Client ID y el Client Secret.");
      return;
    }
    if (mode === "legacy" && !token.trim()) {
      setError("Completá el token shpat_.");
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const body =
        mode === "credentials"
          ? { domain: dom.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() }
          : { domain: dom.trim(), token: token.trim() };
      const res = await fetch("/api/shopify/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      setOk(j.shopName ? `Conectado a ${j.shopName}` : "Conectado");
      setClientId("");
      setClientSecret("");
      setToken("");
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    await fetch("/api/shopify/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disconnect: true }),
    });
    setBusy(false);
    setConfirmingDisconnect(false);
    setEditing(true);
    setDom("");
    router.refresh();
  }

  const inputCls = sharedInputCls;
  // Permisos reales de la app, visibles apenas está conectada.
  const scopesState = useShopifyScopes(connected && !editing);

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight text-neutral-900">🛍️ Shopify</h2>
          <p className="text-xs text-neutral-500">
            Conectá la tienda para que el agente pueda buscar productos, ver pedidos y crear links
            de pago. Después activás cada capacidad en{" "}
            <a href="/agent?tab=acciones" className="font-medium text-neutral-700 underline">
              Agente → Acciones
            </a>
            .
          </p>
        </div>
        {connected && !editing && (
          <Badge color="green">Conectado</Badge>
        )}
      </div>

      {connected && !editing ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-neutral-700">
              Tienda: <span className="font-medium">{domain}</span>
            </span>
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Cambiar credenciales
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => setConfirmingDisconnect(true)}
              disabled={busy}
            >
              Desconectar
            </Button>
          </div>
          <ShopifyScopesSummary state={scopesState} />
          <ConfirmDialog
            open={confirmingDisconnect}
            title="Desconectar Shopify"
            description="El agente dejará de consultar la tienda. Podrás volver a conectar en cualquier momento."
            confirmLabel="Desconectar"
            tone="danger"
            busy={busy}
            onConfirm={disconnect}
            onCancel={() => setConfirmingDisconnect(false)}
          />
        </>
      ) : (
        <div className="space-y-3">
          <details className="rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
            <summary className="cursor-pointer font-medium text-neutral-700">
              ¿Cómo obtengo las credenciales? (1 sola vez)
            </summary>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>
                Entrá al{" "}
                <a
                  href="https://dev.shopify.com/dashboard"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline"
                >
                  Dev Dashboard de Shopify
                </a>{" "}
                y creá una app para tu tienda (tienda y app deben ser de la misma organización).
              </li>
              <li>
                Dale permisos de la Admin API: <span className="font-mono">read_products</span>,{" "}
                <span className="font-mono">read_inventory</span>,{" "}
                <span className="font-mono">read_orders</span> y{" "}
                <span className="font-mono">write_draft_orders</span> (para los links de pago).
              </li>
              <li>Instalá la app en la tienda.</li>
              <li>
                En la config de la app copiá el <strong>Client ID</strong> y el{" "}
                <strong>Client Secret</strong> (empieza con <span className="font-mono">shpss_</span>
                ) y pegalos acá junto con el dominio <span className="font-mono">.myshopify.com</span>.
                El sistema renueva el token de acceso automáticamente cada 24 h.
              </li>
            </ol>
          </details>

          <p className="text-[11px] text-neutral-500">
            {mode === "legacy"
              ? "Estás usando el modo clásico (token shpat_ de una custom app vieja)."
              : "¿Tenés una custom app vieja con token shpat_?"}{" "}
            <button
              type="button"
              onClick={() => setMode(mode === "legacy" ? "credentials" : "legacy")}
              className="font-medium text-neutral-700 underline"
            >
              {mode === "legacy" ? "Usar Client ID/Secret" : "Usar token clásico"}
            </button>
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-600">Dominio de la tienda</label>
              <input
                value={dom}
                onChange={(e) => setDom(e.target.value)}
                placeholder="mitienda.myshopify.com"
                className={inputCls}
              />
              <p className="text-[11px] text-neutral-400">
                El dominio .myshopify.com, no el dominio propio de la tienda.
              </p>
            </div>
            {mode === "credentials" ? (
              <>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-neutral-600">Client ID</label>
                  <input
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="0ee40696…"
                    className={`${inputCls} font-mono`}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-neutral-600">Client Secret</label>
                  <input
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    type="password"
                    placeholder="shpss_…"
                    className={`${inputCls} font-mono`}
                  />
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <label className="text-xs font-medium text-neutral-600">
                  Admin API access token (legacy)
                </label>
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  type="password"
                  placeholder="shpat_…"
                  className={`${inputCls} font-mono`}
                />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="primary" onClick={connect} busy={busy}>
              {busy ? "Validando…" : "Conectar y validar"}
            </Button>
            {connected && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancelar
              </Button>
            )}
            {ok && <span className="text-xs text-emerald-600">✓ {ok}</span>}
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
