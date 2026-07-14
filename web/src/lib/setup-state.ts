// server-only: lee runtime_config para computar el progreso del onboarding.
// Compartido por el deep-link /setup y el panel lateral (drawer) del dashboard
// para que ambos calculen "listo" desde la MISMA fuente de verdad.
//
// IMPORTANTE: la completitud de cada paso se computa SOLO desde la DB
// (getRuntimeConfig), NO con el fallback a env. Un valor que existe únicamente
// en el env del host NO debe marcar un paso como hecho: el trabajo del wizard es
// justamente poblar runtime_config, así que "hecho" = "el wizard lo escribió en DB".

import { getRuntimeConfig } from "@/lib/runtime-config";

export type SetupPrefill = {
  operatorName: string;
  agentName: string;
  agentLabel: string;
  agentEnvironmentName: string;
  agentModel: string;
  masterStoreName: string;
  leadsStoreName: string;
  subdomain: string;
  apiDomain: string;
};

export type SetupProvisioned = {
  masterId: string | null;
  leadsId: string | null;
  environmentId: string | null;
  agentId: string | null;
  agentVersion: string | null;
};

export type SetupState = {
  credentialsDone: boolean;
  memoryDone: boolean;
  agentDone: boolean;
  kommoDone: boolean;
  hasSystemPrompt: boolean;
  prefill: SetupPrefill;
  provisioned: SetupProvisioned;
};

/** Estado del wizard derivado de runtime_config (DB-only). */
export async function getSetupState(): Promise<SetupState> {
  const db = await getRuntimeConfig(); // mapa DB-only (null/"" ya filtrados)
  const v = (k: string) => db[k] ?? "";

  return {
    credentialsDone: Boolean(v("ANTHROPIC_API_KEY")),
    memoryDone: Boolean(v("ANTHROPIC_MEMORY_MASTER_ID") && v("ANTHROPIC_MEMORY_LEADS_ID")),
    agentDone: Boolean(v("ANTHROPIC_AGENT_ID")),
    kommoDone: Boolean(v("KOMMO_ACCESS_TOKEN")),
    hasSystemPrompt: Boolean(v("SYSTEM_PROMPT")),
    prefill: {
      operatorName: v("OPERATOR_NAME"),
      agentName: v("AGENT_NAME"),
      agentLabel: v("NEXT_PUBLIC_AGENT_LABEL"),
      agentEnvironmentName: v("AGENT_ENVIRONMENT_NAME"),
      agentModel: v("AGENT_MODEL"),
      masterStoreName: v("MEMORY_STORE_MASTER_NAME"),
      leadsStoreName: v("MEMORY_STORE_LEADS_NAME"),
      subdomain: v("KOMMO_SUBDOMAIN"),
      apiDomain: v("KOMMO_API_DOMAIN"),
    },
    provisioned: {
      masterId: v("ANTHROPIC_MEMORY_MASTER_ID") || null,
      leadsId: v("ANTHROPIC_MEMORY_LEADS_ID") || null,
      environmentId: v("ANTHROPIC_ENVIRONMENT_ID") || null,
      agentId: v("ANTHROPIC_AGENT_ID") || null,
      agentVersion: v("ANTHROPIC_AGENT_VERSION") || null,
    },
  };
}
