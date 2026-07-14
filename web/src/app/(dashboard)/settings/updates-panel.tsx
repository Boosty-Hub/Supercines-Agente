"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Switch } from "@/components/ui";

type FnStatus = "missing" | "changed" | "ok";
type FnItem = { slug: string; status: FnStatus };
type Updates = {
  ok: boolean;
  hasSupabaseEnv: boolean;
  hasToken?: boolean;
  error?: string;
  migrations: { applied: number; total: number; pending: string[] };
  functions: { total: number; items: FnItem[] };
};

const FN_LABEL: Record<Exclude<FnStatus, "ok">, string> = {
  missing: "nueva",
  changed: "cambió",
};

export function UpdatesPanel({ autoUpdateEnabled = true }: { autoUpdateEnabled?: boolean }) {
  const [data, setData] = useState<Updates | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [autoOn, setAutoOn] = useState(autoUpdateEnabled);
  const [autoBusy, setAutoBusy] = useState(false);

  async function toggleAuto(v: boolean) {
    const prev = autoOn;
    setAutoOn(v);
    setAutoBusy(true);
    try {
      const res = await fetch("/api/settings/auto-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setAutoOn(prev);
    } finally {
      setAutoBusy(false);
    }
  }

  const check = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/provision/updates");
      const j = (await res.json()) as Updates;
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  async function runMigrations(): Promise<boolean> {
    for (let i = 0; i < 60; i++) {
      const res = await fetch("/api/provision/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(token ? { accessToken: token } : {}),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(j.error || `HTTP ${res.status}`);
        return false;
      }
      setProgress(`Migraciones ${j.applied}/${j.total}…`);
      if (j.done || !j.justApplied) break;
    }
    return true;
  }

  async function runFunctions(items: FnItem[]): Promise<boolean> {
    const todo = items.filter((i) => i.status !== "ok");
    let done = 0;
    for (const it of todo) {
      setProgress(`Desplegando ${it.slug} (${done + 1}/${todo.length})…`);
      const res = await fetch("/api/provision/functions/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(token ? { slug: it.slug, accessToken: token } : { slug: it.slug }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setError(j.error || `Falló el deploy de ${it.slug}`);
        return false;
      }
      done++;
    }
    return true;
  }

  async function applyAll() {
    if (!data) return;
    setWorking(true);
    setError(null);
    setProgress("Aplicando…");
    const okM = await runMigrations();
    if (okM) await runFunctions(data.functions.items);
    setWorking(false);
    setProgress("");
    await check();
  }

  // ── Estados ────────────────────────────────────────────────────────────
  const pendingMig = data?.migrations.pending ?? [];
  const fnsToUpdate = (data?.functions.items ?? []).filter((i) => i.status !== "ok");
  const hasUpdates = pendingMig.length > 0 || fnsToUpdate.length > 0;
  const needsToken = data?.hasToken === false;

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
            Actualizaciones del sistema
          </h2>
          <p className="text-xs text-neutral-500">
            Sincroniza la base de datos (migraciones) y las Edge Functions con la versión del
            código desplegado.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={check}
          disabled={loading || working}
        >
          {loading ? "Buscando…" : "Buscar"}
        </Button>
      </div>

      {loading && !data ? (
        <p className="text-sm text-neutral-400">Buscando actualizaciones…</p>
      ) : data && !data.hasSupabaseEnv ? (
        <p className="text-sm text-red-600">Supabase no está configurado en este entorno.</p>
      ) : needsToken ? (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-800">
            <span className="font-medium">Falta el token de Supabase</span> — sin él no se pueden
            detectar ni aplicar actualizaciones (ni desde acá ni con el aviso automático). Pegá tu
            Personal Access Token (<span className="font-mono">sbp_…</span>), el mismo del wizard de
            configuración inicial. Queda guardado y no se vuelve a pedir.
          </p>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="sbp_..."
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>
      ) : null}

      {data && data.hasSupabaseEnv && !needsToken && (
        <>
          {!hasUpdates ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              <span>✓</span>
              <span>
                Todo al día — {data.migrations.applied}/{data.migrations.total} migraciones,{" "}
                {data.functions.total} funciones desplegadas.
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                Hay actualizaciones disponibles.
              </div>

              {pendingMig.length > 0 && (
                <div className="rounded-lg border border-neutral-200 p-3">
                  <p className="text-sm font-medium text-neutral-900">
                    {pendingMig.length} migración{pendingMig.length > 1 ? "es" : ""} nueva
                    {pendingMig.length > 1 ? "s" : ""}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {pendingMig.map((m) => (
                      <li key={m} className="font-mono text-xs text-neutral-500">
                        {m}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {fnsToUpdate.length > 0 && (
                <div className="rounded-lg border border-neutral-200 p-3">
                  <p className="text-sm font-medium text-neutral-900">
                    {fnsToUpdate.length} función{fnsToUpdate.length > 1 ? "es" : ""} para actualizar
                  </p>
                  <ul className="mt-1 space-y-1">
                    {fnsToUpdate.map((f) => (
                      <li key={f.slug} className="flex items-center gap-2">
                        <span className="font-mono text-xs text-neutral-600">{f.slug}</span>
                        <Badge color={f.status === "missing" ? "green" : "amber"}>
                          {FN_LABEL[f.status as "missing" | "changed"]}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="primary"
                  onClick={applyAll}
                  disabled={working || (needsToken && !token.trim())}
                  busy={working}
                >
                  {working ? "Actualizando…" : "Actualizar todo"}
                </Button>
                {working && progress && (
                  <span className="text-sm text-neutral-500">{progress}</span>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-start justify-between gap-4 border-t border-neutral-100 pt-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-neutral-900">Actualización automática</p>
          <p className="text-xs text-neutral-500">
            Al abrir el dashboard después de un deploy nuevo, las migraciones y funciones
            pendientes se aplican solas (verás el progreso en una barra arriba del dashboard).
            Corre una vez por sesión; sin esperas ni pasos manuales.
          </p>
        </div>
        <Switch
          checked={autoOn}
          disabled={autoBusy}
          onChange={toggleAuto}
          tone="brand"
        />
      </div>
    </section>
  );
}
