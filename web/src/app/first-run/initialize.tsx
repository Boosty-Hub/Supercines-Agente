"use client";

// INVARIANT: this file must not import runtime-config or createServiceClient

import { useState } from "react";
import type { ProvisionStatus } from "@/app/api/provision/status/route";
import { Button } from "@/components/ui/button";
import { inputCls } from "@/components/ui/styles";

type Phase = "idle" | "migrations" | "functions" | "done" | "error";

function ProgressRow({
  label,
  current,
  total,
  state,
}: {
  label: string;
  current: number;
  total: number;
  state: "pending" | "running" | "done";
}) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-neutral-700">{label}</span>
        {state === "done" ? (
          <span className="text-xs font-medium text-emerald-600">Listo ✓</span>
        ) : state === "running" ? (
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />
        ) : null}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${state === "done" ? 100 : pct}%` }}
        />
      </div>
    </div>
  );
}

export function Initialize({
  initialStatus,
  onComplete,
}: {
  initialStatus: ProvisionStatus;
  onComplete: () => void;
}) {
  const [accessToken, setAccessToken] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const [migProgress, setMigProgress] = useState({
    current: initialStatus.migrationsApplied.applied,
    total: initialStatus.migrationsApplied.total,
  });
  const [fnProgress, setFnProgress] = useState({
    current: initialStatus.functionsDeployed.count,
    total: initialStatus.functionsDeployed.total,
  });

  const running = phase === "migrations" || phase === "functions";

  async function runInitialize() {
    if (!accessToken.trim()) {
      setError("Pegá tu token de Supabase para continuar.");
      return;
    }
    setError(null);
    const token = accessToken.trim();

    // Phase 1 — database (migrations under the hood)
    setPhase("migrations");
    while (true) {
      try {
        const res = await fetch("/api/provision/migrate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken: token }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean; done?: boolean; applied?: number; total?: number; error?: string;
        };
        if (!res.ok || data.ok === false) {
          setError(data.error ?? `Error al preparar la base de datos (HTTP ${res.status})`);
          setPhase("error");
          return;
        }
        if (data.applied !== undefined && data.total !== undefined) {
          setMigProgress({ current: data.applied, total: data.total });
        }
        if (data.done) break;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error de conexión");
        setPhase("error");
        return;
      }
    }

    // Phase 2 — agent (edge functions under the hood)
    setPhase("functions");
    while (true) {
      try {
        const res = await fetch("/api/provision/functions/deploy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken: token }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean; done?: boolean; count?: number; total?: number; error?: string;
        };
        if (!res.ok || data.ok === false) {
          setError(data.error ?? `Error al activar el agente (HTTP ${res.status})`);
          setPhase("error");
          return;
        }
        if (data.count !== undefined && data.total !== undefined) {
          setFnProgress({ current: data.count, total: data.total });
        }
        if (data.done) break;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error de conexión");
        setPhase("error");
        return;
      }
    }

    setPhase("done");
    onComplete();
  }

  const migState: "pending" | "running" | "done" =
    phase === "migrations" ? "running" : phase === "functions" || phase === "done" ? "done" : "pending";
  const fnState: "pending" | "running" | "done" =
    phase === "functions" ? "running" : phase === "done" ? "done" : "pending";
  const showProgress = phase !== "idle" || migProgress.current > 0 || fnProgress.current > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900">
          Preparamos tu sistema
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Dejamos todo listo para que tu agente funcione. Tarda un par de
          minutos — no cierres esta pestaña.
        </p>
      </div>

      {/* Token input — the one thing we need from you */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-neutral-700">
          Token de Supabase
        </label>
        <input
          type="password"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          placeholder="sbp_..."
          className={inputCls + " font-mono"}
          disabled={running}
        />
        <p className="text-xs text-neutral-500">
          Generalo en{" "}
          <a
            href="https://supabase.com/dashboard/account/tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            supabase.com/dashboard/account/tokens
          </a>{" "}
          → <strong>Generate new token</strong>. Empieza con <code>sbp_</code>.
        </p>
      </div>

      {/* Friendly progress */}
      {showProgress && (
        <div className="space-y-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4">
          <ProgressRow
            label="Creando la base de datos"
            current={migProgress.current}
            total={migProgress.total}
            state={migState}
          />
          <ProgressRow
            label="Activando tu agente"
            current={fnProgress.current}
            total={fnProgress.total}
            state={fnState}
          />
        </div>
      )}

      {error && (
        <div className="space-y-1.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          <p className="font-medium">
            Algo falló, pero podés reintentar — sigue desde donde quedó.
          </p>
          <p className="font-mono">{error}</p>
        </div>
      )}

      <Button
        type="button"
        onClick={() => {
          setError(null);
          void runInitialize();
        }}
        busy={running}
        disabled={running}
      >
        {phase === "migrations" || phase === "functions"
          ? "Preparando…"
          : phase === "error"
          ? "Reintentar"
          : phase === "done"
          ? "¡Listo!"
          : "Preparar todo"}
      </Button>
    </div>
  );
}
