// Secretos atados a un destino (URL/host): viven SOLO en runtime_config, nunca en el entorno.
//
// POR QUÉ: `setConfigValues` valida al cambiar el destino de un par (BCV_RATE_URL, KOMMO_API_DOMAIN,
// SHOPIFY_STORE_DOMAIN, TOOL_<X>_HOSTS) que el secreto se reenvíe o se borre. Pero el entorno de la
// web y el de las Edge Functions (Deno.env: secrets de Supabase) son DISTINTOS: un secreto que vive
// en `Deno.env` (o en process.env de la web) seguiría vigente tras el cambio de destino y viajaría
// al host nuevo sin que nadie lo reingresara. Por eso, para estas claves NO hay fallback al entorno
// (ni en la web ni en las Edge): el valor es el de la base o no existe. Así la validación del par
// decide sobre lo único que puede viajar. El wizard /setup ya escribe todo en runtime_config (ver
// «Precedencia de config» en CLAUDE.md); el entorno queda solo para los 3 secretos de arranque de
// Supabase y para claves no atadas a un destino.
//
// ESTA ES LA COPIA de web/src/lib/db-only-secret-keys.ts (idéntica desde `export const DB_ONLY_SECRET_KEYS`;
// web/src/lib/db-only-secret-keys.test.ts lo verifica).

export const DB_ONLY_SECRET_KEYS = [
  "BCV_RATE_APIKEY",
  "KOMMO_ACCESS_TOKEN",
  "SHOPIFY_ACCESS_TOKEN",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
] as const;

const CUSTOM_TOOL_SECRET_RE = /^TOOL_[A-Z0-9_]{1,64}$/;

/** ¿Este secreto atado a un destino debe leerse SOLO de runtime_config (sin fallback al entorno)? */
export function isDbOnlySecretKey(key: string): boolean {
  if ((DB_ONLY_SECRET_KEYS as readonly string[]).includes(key)) return true;
  return CUSTOM_TOOL_SECRET_RE.test(key) && !key.endsWith("_HOSTS");
}
