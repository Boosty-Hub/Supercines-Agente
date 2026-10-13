// server-only: ¿el agente VIVO en Anthropic coincide con lo que este código y
// esta config esperan? Dos desfases silenciosos, ambos reales:
//  1) scaffold: el CORE_SCAFFOLD del código cambió (deploy) pero el agente sigue
//     con el system prompt viejo hasta el próximo sync. Se detecta comparando la
//     huella guardada al sincronizar (AGENT_SCAFFOLD_HASH) con la del código.
//  2) modelo: runtime_config.AGENT_MODEL dice una cosa y el agente en Anthropic
//     corre otra (la key vacía/desfasada, un cambio que no llegó).
//
// POR QUÉ NO SE RE-SINCRONIZA SOLO: un sync empuja el system prompt al agente
// (sube su versión y afecta a las sesiones nuevas). Dispararlo desde el render de
// una página GET es un efecto secundario sobre producción, concurrente entre
// pestañas y sin que nadie lo decida. En su lugar se AVISA con un banner y un
// botón "Sincronizar" (POST /api/agent/sync, alcance configuracion) que
// ejecuta syncAgentTools, que ya maneja la concurrencia optimista.

import { configValues } from "@/lib/runtime-config";
import { retrieveAgent } from "@/lib/anthropic-managed";
import type { AgentRetriever } from "@/lib/once-retriever";
import { scaffoldHash } from "@/lib/agent-prompt";
import { MODEL_KEYS } from "@/lib/model-config";

export type AgentSyncStatus = {
  provisioned: boolean;
  /** El scaffold del código difiere del último sincronizado (o nunca se guardó la huella). */
  scaffoldStale: boolean;
  /** Modelo según runtime_config (o el default del pipeline). */
  configModel: string;
  /** Modelo que Anthropic tiene guardado en el agente; null si no se pudo leer. */
  liveModel: string | null;
  modelDrift: boolean;
};

export function liveModelId(model: unknown): string | null {
  if (typeof model === "string" && model) return model;
  const id = (model as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? id : null;
}

/** `retrieve`: inyectable para compartir la lectura del agente con otras consultas del mismo render (lib/once-retriever). */
export async function getAgentSyncStatus(retrieve: AgentRetriever = retrieveAgent): Promise<AgentSyncStatus> {
  const cfg = await configValues(["ANTHROPIC_API_KEY", "ANTHROPIC_AGENT_ID", "AGENT_MODEL", "AGENT_SCAFFOLD_HASH"]);
  const configModel = cfg.AGENT_MODEL || MODEL_KEYS.AGENT_MODEL;
  if (!cfg.ANTHROPIC_API_KEY || !cfg.ANTHROPIC_AGENT_ID) {
    return { provisioned: false, scaffoldStale: false, configModel, liveModel: null, modelDrift: false };
  }
  let liveModel: string | null = null;
  try {
    liveModel = liveModelId((await retrieve(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_AGENT_ID)).model);
  } catch {
    // Anthropic degradado: no se afirma un desfase que no se pudo comprobar.
  }
  return {
    provisioned: true,
    scaffoldStale: cfg.AGENT_SCAFFOLD_HASH !== scaffoldHash(),
    configModel,
    liveModel,
    modelDrift: liveModel !== null && liveModel !== configModel,
  };
}
