// Estado del agente para UNA conversación, calculado server-side con la MISMA
// lógica de gates que generate-response / publish-to-kommo. Hace visible en el
// header del inbox POR QUÉ un lead recibe (o no) respuesta, sin tener que adivinar.
//
// Precedencia (de más bloqueante a OK):
//   1. agent_enabled=false        → 🔴 apagado para TODOS (kill switch)
//   2. etapa ∈ ignored_stage_ids  → 🟠 el agente ignora esta etapa
//   3. publishing_enabled=false   → 🟡 responde pero no envía (modo validación)
//   4. salesbot_id null           → 🟡 genera pero no puede entregar
//   5. todo OK                    → 🟢 activo

export type AgentStatusTone = "green" | "amber" | "red";

export type AgentStatus = {
  tone: AgentStatusTone;
  label: string;
  detail: string;
  fixHref?: string;
  fixLabel?: string;
};

export function computeAgentStatus(input: {
  agentEnabled: boolean;
  publishingEnabled: boolean;
  salesbotId: number | null;
  ignoredStageIds: number[];
  stageId: number | null;
}): AgentStatus {
  const { agentEnabled, publishingEnabled, salesbotId, ignoredStageIds, stageId } = input;

  if (!agentEnabled) {
    return {
      tone: "red",
      label: "Agente apagado",
      detail: "El interruptor general está apagado: el agente no responde a NINGÚN lead.",
      fixHref: "/config/kommo",
      fixLabel: "Encender en Kommo",
    };
  }
  if (stageId != null && ignoredStageIds.includes(stageId)) {
    return {
      tone: "amber",
      label: "Etapa ignorada",
      detail:
        "Este lead está en una etapa que el agente tiene configurada para ignorar — no le genera respuesta. Movelo de etapa o sacá esa etapa de la lista de ignoradas.",
      fixHref: "/agent?tab=filtros",
      fixLabel: "Ver etapas ignoradas",
    };
  }
  if (!publishingEnabled) {
    return {
      tone: "amber",
      label: "Modo validación",
      detail:
        "El agente responde y guarda el borrador, pero NO lo envía al cliente (publicación apagada).",
      fixHref: "/config/kommo",
      fixLabel: "Activar publicación",
    };
  }
  if (!salesbotId) {
    return {
      tone: "amber",
      label: "Falta el Salesbot",
      detail:
        "El agente genera la respuesta pero no puede entregarla: falta configurar el Salesbot ID de Kommo.",
      fixHref: "/config/kommo",
      fixLabel: "Configurar Salesbot",
    };
  }
  return {
    tone: "green",
    label: "Agente activo",
    detail: "El agente responde y publica en esta conversación.",
  };
}

const TONE_CLS: Record<AgentStatusTone, string> = {
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  red: "bg-red-50 text-red-700 border-red-200",
};
const DOT_CLS: Record<AgentStatusTone, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return (
    <div className="mt-1.5 space-y-1">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_CLS[status.tone]}`}
        title={status.detail}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLS[status.tone]}`} />
        {status.label}
      </span>
      {status.tone !== "green" && (
        <p className="text-[11px] leading-snug text-neutral-500">
          {status.detail}
          {status.fixHref && (
            <>
              {" "}
              <a href={status.fixHref} className="font-medium text-neutral-700 underline">
                {status.fixLabel}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
