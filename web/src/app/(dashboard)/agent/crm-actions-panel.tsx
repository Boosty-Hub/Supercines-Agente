"use client";

import { useState } from "react";
import { Switch, CapabilityCard } from "./action-ui";

export type CrmFlags = {
  enabled: boolean; // master
  moveStage: boolean;
  updateLead: boolean;
  updateContact: boolean;
};

const FIELD: Record<keyof CrmFlags, string> = {
  enabled: "crm_actions_enabled",
  moveStage: "crm_can_move_stage",
  updateLead: "crm_can_update_lead",
  updateContact: "crm_can_update_contact",
};

export function CrmActionsPanel({ initial }: { initial: CrmFlags }) {
  const [flags, setFlags] = useState<CrmFlags>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function persist(patch: Record<string, boolean>, optimistic: CrmFlags) {
    const prev = flags;
    setFlags(optimistic);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/crm-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setFlags(prev); // revertir
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleMaster(v: boolean) {
    // Apagar el master apaga todo (espejo de la lógica del backend).
    const next: CrmFlags = v
      ? { ...flags, enabled: true }
      : { enabled: false, moveStage: false, updateLead: false, updateContact: false };
    const patch: Record<string, boolean> = v
      ? { crm_actions_enabled: true }
      : {
          crm_actions_enabled: false,
          crm_can_move_stage: false,
          crm_can_update_lead: false,
          crm_can_update_contact: false,
        };
    persist(patch, next);
  }

  function toggleCap(key: keyof CrmFlags, v: boolean) {
    persist({ [FIELD[key]]: v }, { ...flags, [key]: v });
  }

  const capsDisabled = !flags.enabled || busy;

  return (
    <div className="space-y-6">
      {/* Master */}
      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
              Permitir que el agente actúe en el CRM
            </h2>
            <p className="text-xs text-neutral-500">
              Cuando está activo, el agente puede —además de responder— mover el lead de etapa y
              completar datos en Kommo, identificando etapas y campos{" "}
              <span className="font-medium text-neutral-700">por nombre</span> (los lee en vivo,
              no hace falta configurar códigos). Solo actúa cuando se lo indicás.
            </p>
          </div>
          <Switch checked={flags.enabled} disabled={busy} onChange={toggleMaster} />
        </div>
        {!flags.enabled && (
          <p className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
            🔒 Apagado. El agente NO toca el CRM. Nada se ejecuta hasta que lo actives.
          </p>
        )}
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      </div>

      {/* Capacidades */}
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          ¿Qué puede hacer?
        </p>
        <CapabilityCard
          icon="🔀"
          title="Mover de etapa"
          description="Mueve el lead a otra etapa del embudo (ej: pasarlo a 'Ganado' cuando confirma la compra)."
          checked={flags.moveStage}
          disabled={capsDisabled}
          onChange={(v) => toggleCap("moveStage", v)}
        />
        <CapabilityCard
          icon="✏️"
          title="Actualizar datos del lead"
          description="Completa campos del lead (ej: presupuesto, ciudad, producto de interés)."
          checked={flags.updateLead}
          disabled={capsDisabled}
          onChange={(v) => toggleCap("updateLead", v)}
        />
        <CapabilityCard
          icon="👤"
          title="Actualizar datos del contacto"
          description="Completa campos del contacto del lead (ej: email, cumpleaños)."
          checked={flags.updateContact}
          disabled={capsDisabled}
          onChange={(v) => toggleCap("updateContact", v)}
        />
      </div>

      {/* Cómo indicarle */}
      <div className="space-y-2 rounded-xl border border-violet-200 bg-violet-50 p-4">
        <p className="text-xs font-medium text-neutral-700">✨ Cómo le decís cuándo actuar</p>
        <p className="text-xs text-neutral-600">
          El agente solo actúa cuando una instrucción se lo pide. Escribila en la{" "}
          <span className="font-medium">voz del agente</span> (tab Identidad) o en una{" "}
          <a href="/verticales" className="font-medium text-violet-700 underline">
            vertical
          </a>
          . Ejemplos que podés pegar:
        </p>
        <div className="space-y-1.5 pt-1">
          {[
            "Cuando el lead confirme la compra, movelo a la etapa «Ganado».",
            "Si el lead te dice su presupuesto, guardalo en el campo «Presupuesto» del lead.",
            "Cuando te den el email, guardalo en el campo «Email» del contacto.",
          ].map((ej) => (
            <p
              key={ej}
              className="rounded-lg border border-violet-200 bg-white px-3 py-2 text-xs text-neutral-700"
            >
              “{ej}”
            </p>
          ))}
        </div>
        <p className="pt-1 text-[11px] text-neutral-500">
          No necesitás saber IDs ni códigos: el agente busca la etapa o el campo por su nombre tal
          como aparece en Kommo. Si lo escribís parecido, igual lo encuentra.
        </p>
      </div>
    </div>
  );
}
