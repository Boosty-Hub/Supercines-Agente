"use client";

// Conexión con Kommo (subdominio + token de larga duración). Antes solo era
// editable en el wizard /setup; ahora también acá, en Config → Kommo. Reutiliza
// el MISMO verificador (/api/setup/kommo): decodifica el JWT, valida contra
// /api/v4/account y persiste kommo_credentials + KOMMO_* en runtime_config.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, SectionCard, inputCls } from "@/components/ui";

function parseSubdomain(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/\.kommo\.com.*$/i, "").replace(/\/.*$/, "");
}

export function KommoConnectionCard({
  initialSubdomain,
  accountId,
  expiresAt,
  connected,
}: {
  initialSubdomain: string;
  accountId: number | null;
  expiresAt: string | null;
  connected: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(!connected);
  const [subdomain, setSubdomain] = useState(initialSubdomain);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const sd = parseSubdomain(subdomain);
    if (!sd || !token.trim()) {
      setError("Ingresá el subdominio y el token de larga duración.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/kommo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain: sd, accessToken: token.trim() }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setToken("");
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Conexión"
      description="El subdominio y el token de larga duración de tu cuenta Kommo."
      action={
        <Badge color={connected ? "green" : "amber"}>
          {connected ? "Conectado" : "Sin conectar"}
        </Badge>
      }
    >
      {connected && !editing && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-xs uppercase tracking-wide text-neutral-500">Subdominio</p>
              <p className="mt-1 font-mono text-sm text-neutral-900">{initialSubdomain}.kommo.com</p>
            </div>
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-xs uppercase tracking-wide text-neutral-500">Cuenta</p>
              <p className="mt-1 font-mono text-sm text-neutral-900">{accountId ?? "—"}</p>
            </div>
          </div>
          {expiresAt && (
            <p className="text-xs text-neutral-500">
              Token válido hasta{" "}
              {new Date(expiresAt).toLocaleDateString("es", { dateStyle: "medium" })}.
            </p>
          )}
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Cambiar credenciales
          </Button>
        </div>
      )}

      {editing && (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">Subdominio</label>
            <div className="flex items-center gap-2">
              <input
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                placeholder="miempresa"
                className={inputCls + " font-mono"}
              />
              <span className="text-sm text-neutral-500">.kommo.com</span>
            </div>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">
              Token de larga duración
            </label>
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="eyJ0eXAiOiJKV1Qi…"
              rows={3}
              className={inputCls + " font-mono text-xs"}
            />
            <p className="text-xs text-neutral-500">
              Kommo → Ajustes → Integraciones → tu integración → “Token de larga duración”.
            </p>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={connect} disabled={busy}>
              {busy ? "Validando…" : "Conectar y validar"}
            </Button>
            {connected && (
              <Button variant="secondary" onClick={() => { setEditing(false); setError(null); }} disabled={busy}>
                Cancelar
              </Button>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
