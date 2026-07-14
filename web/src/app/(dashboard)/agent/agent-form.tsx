"use client";

import { useState } from "react";
import { AgentPromptAssistant } from "@/components/agent-prompt-assistant";

const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none";

export function AgentForm({
  initial,
}: {
  initial: {
    operatorName: string;
    agentName: string;
    agentLabel: string;
    systemPrompt: string;
  };
}) {
  // Only the system prompt is controlled — the AI assistant edits it live.
  // The other fields stay uncontrolled (defaultValue) and submit normally.
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt);

  return (
    <form
      action="/api/agent"
      method="post"
      className="space-y-5 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-neutral-700">
            Nombre del operador
          </label>
          <input
            type="text"
            name="operator_name"
            defaultValue={initial.operatorName}
            placeholder="Ej: María, Estudio Jurídico X"
            className={inputCls}
          />
          <p className="text-xs text-neutral-500">
            Reemplaza <span className="font-mono">{"{{OPERATOR_NAME}}"}</span> en el prompt.
          </p>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-neutral-700">
            Nombre del agente (Anthropic)
          </label>
          <input
            type="text"
            name="agent_name"
            defaultValue={initial.agentName}
            placeholder="Ej: agente-maria-prod"
            className={inputCls + " font-mono"}
          />
          <p className="text-xs text-neutral-500">
            Identifica el agente en tu cuenta de Anthropic.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-neutral-700">
          Branding del dashboard
        </label>
        <input
          type="text"
          name="agent_label"
          defaultValue={initial.agentLabel}
          placeholder="Ej: Agente de Ventas"
          className={inputCls}
        />
        <p className="text-xs text-neutral-500">
          Título que se muestra en la barra lateral y el login.
        </p>
      </div>

      {/* Asistente IA — franja full-width sobre el textarea */}
      <div className="space-y-2">
        <AgentPromptAssistant value={systemPrompt} onChange={setSystemPrompt} />
        <p className="text-xs text-neutral-500">
          Los cambios se aplican en el prompt de abajo. Acordate de{" "}
          <strong>Guardar y sincronizar</strong> para subirlos a Anthropic.
        </p>
      </div>

      {/* System prompt — ancho completo debajo del asistente */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-neutral-700">
          System prompt — voz e identidad
        </label>
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
          Acá va SOLO la voz, identidad y reglas de negocio del operador. La
          maquinaria técnica (leer la memoria, el formato de salida, el uso de
          la KB, las prioridades y la seguridad anti-abuso) la agrega el sistema
          automáticamente por detrás — no hace falta escribirla acá, y así no se
          puede romper sin querer.
        </p>
        <textarea
          name="system_prompt"
          rows={24}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="La voz e identidad del operador. Podés usar los placeholders {{OPERATOR_NAME}}, {{MASTER_PATH}}, {{LEADS_PATH}}, {{MEMORY_STORE_MASTER}}, {{MEMORY_STORE_LEADS}} — se sustituyen al sincronizar."
          className={inputCls + " font-mono leading-relaxed"}
        />
        <p className="text-xs text-neutral-500">
          Placeholders:{" "}
          <span className="font-mono">{"{{OPERATOR_NAME}}"}</span>,{" "}
          <span className="font-mono">{"{{MASTER_PATH}}"}</span>,{" "}
          <span className="font-mono">{"{{LEADS_PATH}}"}</span>,{" "}
          <span className="font-mono">{"{{MEMORY_STORE_MASTER}}"}</span>,{" "}
          <span className="font-mono">{"{{MEMORY_STORE_LEADS}}"}</span>.
        </p>
      </div>

      <button
        type="submit"
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
      >
        Guardar y sincronizar
      </button>
    </form>
  );
}
