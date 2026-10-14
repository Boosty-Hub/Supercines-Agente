// server-only: lee runtime_config para computar el progreso del onboarding.
// Compartido por el deep-link /setup y el panel lateral (drawer) del dashboard
// para que ambos calculen "listo" desde la MISMA fuente de verdad.
//
// IMPORTANTE: la completitud de cada paso se computa SOLO desde la DB
// (getRuntimeConfig), NO con el fallback a env. Un valor que existe únicamente
// en el env del host NO debe marcar un paso como hecho: el trabajo del wizard es
// justamente poblar runtime_config, así que "hecho" = "el wizard lo escribió en DB".

import { getRuntimeConfig } from "@/lib/runtime-config";
import { setupStateFromConfig, type SetupState } from "@/lib/setup-state-view";

export type { SetupPrefill, SetupProvisioned, SetupSecretHints, SetupState } from "@/lib/setup-state-view";

/** Estado del wizard derivado de runtime_config (DB-only). */
export async function getSetupState(): Promise<SetupState> {
  return setupStateFromConfig(await getRuntimeConfig()); // mapa DB-only (null/"" ya filtrados)
}
