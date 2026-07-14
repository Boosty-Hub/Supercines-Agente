"use client";

import { useState } from "react";
import { Switch } from "./action-ui";
import { Button, ConfirmDialog, inputCls } from "@/components/ui";

export function BcvPanel({
  initialEnabled,
  hasCustomSource,
}: {
  initialEnabled: boolean;
  hasCustomSource: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [showSource, setShowSource] = useState(false);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  async function post(body: Record<string, unknown>, okMsg: string) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch("/api/agent/bcv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setOk(okMsg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
    return true;
  }

  async function toggle(v: boolean) {
    const prev = enabled;
    setEnabled(v);
    const success = await post({ enabled: v }, v ? "Activado" : "Desactivado");
    if (!success) setEnabled(prev);
  }

  async function saveSource() {
    // Vacío = volver a la fuente pública. Si había un endpoint propio,
    // abrir ConfirmDialog para evitar borrarlo por accidente.
    if (!url.trim() && !apiKey.trim() && hasCustomSource) {
      setConfirmingRemove(true);
      return;
    }
    await doSaveSource();
  }

  async function doSaveSource() {
    const success = await post({ url: url.trim(), apiKey: apiKey.trim() }, "Fuente guardada");
    if (success) {
      setUrl("");
      setApiKey("");
      setShowSource(false);
    }
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
            💱 Tasa BCV (USD → Bs)
          </h2>
          <p className="text-xs text-neutral-500">
            El agente consulta la tasa oficial del día para convertir precios a bolívares cuando
            el cliente lo pide. La tasa se cachea 6 horas. Aclara siempre que el monto en Bs es
            aproximado y el total exacto lo confirma el equipo al cobrar.
          </p>
        </div>
        <Switch checked={enabled} disabled={busy} onChange={toggle} />
      </div>

      {!enabled && (
        <p className="rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
          🔒 Apagado. El agente no menciona tasas de cambio hasta que lo actives.
        </p>
      )}

      <div className="text-xs text-neutral-500">
        Fuente actual:{" "}
        <span className="font-medium text-neutral-700">
          {hasCustomSource ? "endpoint propio del operador" : "pública (BCV oficial, sin credenciales)"}
        </span>{" "}
        ·{" "}
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          className="font-medium text-neutral-700 underline"
        >
          {showSource ? "Cancelar" : "Cambiar fuente"}
        </button>
      </div>

      {showSource && (
        <div className="space-y-2 rounded-lg bg-neutral-50 p-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-600">
              URL del endpoint (vacío = volver a la fuente pública)
            </label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/rest/v1/rpc/get_active_rate?p_currency_from=USD&p_currency_to=VES"
              className={inputCls}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-600">API key (opcional)</label>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder="se manda como apikey + Authorization: Bearer"
              className={inputCls}
            />
          </div>
          <Button type="button" variant="primary" size="sm" busy={busy} onClick={saveSource}>
            {busy ? "Guardando…" : "Guardar fuente"}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmingRemove}
        title="Quitar endpoint propio"
        description="Se quitará el endpoint personalizado y el agente volverá a usar la fuente pública del BCV. ¿Continuar?"
        confirmLabel="Quitar"
        tone="default"
        busy={busy}
        onConfirm={async () => {
          setConfirmingRemove(false);
          await doSaveSource();
        }}
        onCancel={() => setConfirmingRemove(false)}
      />

      {ok && <p className="text-xs text-emerald-600">✓ {ok}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
