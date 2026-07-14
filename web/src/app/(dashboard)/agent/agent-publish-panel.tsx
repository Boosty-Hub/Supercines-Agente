"use client";

import { useState } from "react";
import { Switch } from "./action-ui";
import { AgentOffConfig } from "./agent-off";
import type { AgentOff } from "./filters-panel";

export type ReviewMode = "todo" | "normal" | "sin";

export type PublishState = {
  agentEnabled: boolean;
  publishing: boolean;
  reviewMode: ReviewMode;
};

const REVIEW_OPTS: { id: ReviewMode; label: string; hint: string }[] = [
  { id: "todo", label: "Todo a revisión", hint: "Cada respuesta espera aprobación humana antes de publicarse." },
  { id: "normal", label: "Normal", hint: "Publica directo, salvo lo que la clasificación mande a revisión." },
  { id: "sin", label: "Sin revisión", hint: "Publica SIEMPRE, aunque un mensaje entrara a revisión." },
];

export function AgentPublishPanel({
  initial,
  agentOff,
}: {
  initial: PublishState;
  agentOff: AgentOff;
}) {
  const [state, setState] = useState<PublishState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function persist(next: PublishState) {
    const prev = state;
    setState(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_enabled: next.agentEnabled,
          publishing_enabled: next.publishing,
          review_mode: next.reviewMode,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setState(prev); // revertir
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function setPublishing(publishing: boolean) {
    // Al apagar publicación, "Sin revisión" deja de aplicar (bypass se fuerza
    // false en el backend) → lo reflejamos volviendo a "Normal".
    const reviewMode =
      !publishing && state.reviewMode === "sin" ? "normal" : state.reviewMode;
    persist({ ...state, publishing, reviewMode });
  }

  return (
    <div className="space-y-5 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
          Encendido y publicación
        </h2>
        <p className="text-xs text-neutral-500">
          El único lugar para prender el agente, elegir si publica de verdad y cómo pasa por revisión.
        </p>
      </div>

      {/* Master: agente encendido */}
      <div className="flex items-start justify-between gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-neutral-900">Agente encendido</p>
          <p className="text-xs text-neutral-500">
            Interruptor general. Apagado = no genera ninguna respuesta para ningún lead (kill switch).
          </p>
        </div>
        <Switch checked={state.agentEnabled} disabled={busy} onChange={(v) => persist({ ...state, agentEnabled: v })} />
      </div>

      {/* Modo de publicación */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-neutral-900">Modo de publicación</p>
        <div className="inline-flex gap-1 rounded-lg bg-neutral-100 p-1">
          {[
            { on: false, label: "Validación" },
            { on: true, label: "Producción" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              disabled={busy}
              aria-pressed={state.publishing === o.on}
              onClick={() => setPublishing(o.on)}
              className={
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 " +
                (state.publishing === o.on
                  ? "bg-white text-neutral-900 shadow-sm"
                  : "text-neutral-600 hover:text-neutral-900")
              }
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-neutral-500">
          {state.publishing
            ? "Producción: el agente publica sus respuestas en Kommo."
            : "Validación (shadow): genera borradores para revisar, pero NO los envía a Kommo."}
        </p>
      </div>

      {/* Revisión humana (tri-estado) */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-neutral-900">Revisión humana</p>
        <div className="inline-flex flex-wrap gap-1 rounded-lg bg-neutral-100 p-1">
          {REVIEW_OPTS.map((o) => {
            const disabled = busy || (o.id === "sin" && !state.publishing);
            return (
              <button
                key={o.id}
                type="button"
                disabled={disabled}
                aria-pressed={state.reviewMode === o.id}
                onClick={() => persist({ ...state, reviewMode: o.id })}
                className={
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 " +
                  (state.reviewMode === o.id
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-600 hover:text-neutral-900")
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-neutral-500">
          {REVIEW_OPTS.find((o) => o.id === state.reviewMode)?.hint}
          {!state.publishing && " «Sin revisión» requiere Producción."}
        </p>
      </div>

      {/* Apagado por lead (desde Kommo) */}
      <div className="border-t border-neutral-100 pt-4">
        <AgentOffConfig fieldId={agentOff.fieldId} fieldName={agentOff.fieldName} />
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
