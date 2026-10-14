// Estado del wizard de setup que viaja al drawer (componente CLIENTE), armado a partir del mapa
// DB-only de runtime_config. Puro (sin imports de servidor): lo prueba config-secrets.test.ts.
//
// Todo valor pasa por la clasificación de secretos (lib/config-secrets.ts): una clave secreta
// nunca sale en claro, solo `set` y su versión enmascarada (••••1234).

import { configEntryView, maskSecret } from "./config-secrets.ts";

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

/** Secretos ya guardados, SOLO enmascarados (••••1234): el estado viaja al drawer (cliente). */
export type SetupSecretHints = {
  anthropicApiKey: string | null;
  kommoAccessToken: string | null;
};

export type SetupState = {
  credentialsDone: boolean;
  memoryDone: boolean;
  agentDone: boolean;
  kommoDone: boolean;
  hasSystemPrompt: boolean;
  prefill: SetupPrefill;
  provisioned: SetupProvisioned;
  secrets: SetupSecretHints;
};

/** Estado del wizard a partir del mapa DB-only de runtime_config (null/"" ya filtrados). */
export function setupStateFromConfig(db: Readonly<Record<string, string | undefined>>): SetupState {
  // Una clave secreta acá devolvería "" en vez de su valor.
  const v = (k: string) => {
    const e = configEntryView(k, db[k]);
    return e.secret ? "" : e.value ?? "";
  };
  const has = (k: string) => Boolean(db[k]);

  return {
    credentialsDone: has("ANTHROPIC_API_KEY"),
    memoryDone: Boolean(v("ANTHROPIC_MEMORY_MASTER_ID") && v("ANTHROPIC_MEMORY_LEADS_ID")),
    agentDone: Boolean(v("ANTHROPIC_AGENT_ID")),
    kommoDone: has("KOMMO_ACCESS_TOKEN"),
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
    secrets: {
      anthropicApiKey: maskSecret(db.ANTHROPIC_API_KEY),
      kommoAccessToken: maskSecret(db.KOMMO_ACCESS_TOKEN),
    },
  };
}
