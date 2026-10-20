// Clasificación ÚNICA de las claves de runtime_config: cuáles son secretas, cómo se muestran y
// quién puede escribirlas. La usan las rutas y las páginas del panel; las Edge Functions leen
// runtime_config con service_role y no pasan por acá.
//
// ── DEFAULT SEGURO: CLAVE DESCONOCIDA ⇒ SECRETA ──────────────────────────────────
// La lista que se mantiene es la de lo PÚBLICO (lo que se puede mostrar en claro a quien
// tenga la vista), no la de los secretos: una clave nueva que alguien agregue sin pensar en
// esto (un `FOO_API_KEY`, un `TOOL_X`, un `BCV_RATE_URL` con la key en el query) nace secreta
// y se muestra enmascarada. Olvidarse de clasificar falla CERRADO.
//
// ── UN SECRETO NUNCA VIAJA AL NAVEGADOR ──────────────────────────────────────────
// Ni a quien tiene alcance `configuracion`: se muestra `••••1234` (últimos 4, y solo si el
// valor es lo bastante largo como para que 4 caracteres no lo revelen) y se REEMPLAZA (la UI
// manda un valor nuevo; nunca se lee el actual para rellenar un input).
//
// Módulo puro (sin imports de servidor): lo importan los tests de node.

import type { Scope } from "./auth/roles.ts";

/** Claves que se pueden mostrar en claro a quien tenga la vista. Todo lo demás es secreto. */
export const PUBLIC_CONFIG_KEYS: ReadonlySet<string> = new Set([
  // Identidad del agente
  "OPERATOR_NAME",
  "AGENT_NAME",
  "AGENT_DESCRIPTION",
  "NEXT_PUBLIC_AGENT_LABEL",
  "SYSTEM_PROMPT",
  "AGENT_ENVIRONMENT_NAME",
  "MEMORY_STORE_MASTER_NAME",
  "MEMORY_STORE_LEADS_NAME",
  // IDs de recursos de Anthropic (no autorizan nada sin la API key)
  "ANTHROPIC_AGENT_ID",
  "ANTHROPIC_AGENT_VERSION",
  "ANTHROPIC_ENVIRONMENT_ID",
  "ANTHROPIC_MEMORY_MASTER_ID",
  "ANTHROPIC_MEMORY_LEADS_ID",
  // Modelos
  "AGENT_MODEL",
  "CLASSIFY_MODEL",
  "COMMENT_REPLY_MODEL",
  "GRADER_MODEL",
  "DREAMS_MODEL",
  // Kommo (dominio, no el token)
  "KOMMO_SUBDOMAIN",
  "KOMMO_API_DOMAIN",
  "HANDOFF_STAGE_NAME",
  "HANDOFF_PIPELINE_NAME",
  "ZONAS_DERIVACION",
  // Shopify (tienda y versión, no las credenciales)
  "SHOPIFY_STORE_DOMAIN",
  "SHOPIFY_API_VERSION",
  // Operación
  "AUTO_UPDATE_ENABLED",
  "DREAMS_AUTO_ACTIVATE",
  "DREAMS_FREQUENCY",
  "DREAMS_RESUMED_AT",
  // Notas de Dreams para el operador (gaps de KB…): las escribe dreams-run, las lee /dreams.
  "DREAMS_OPERATOR_NOTES",
  "MONTHLY_BUDGET_USD",
  "BUDGET_SAFETY_MARGIN_PCT",
  "BUDGET_EXCLUDE_BEFORE",
]);

// TOOL_<X>_HOSTS declara a qué hosts viaja el secreto TOOL_<X> (lib/http-tool-keys.ts): es un
// dato, no un secreto. TOOL_<X> sí lo es (no está en la lista → secreto).
const PUBLIC_CONFIG_PATTERNS: readonly RegExp[] = [/^TOOL_[A-Z0-9_]{1,64}_HOSTS$/];

/** ¿Es secreta? Default seguro: lo que no está declarado público, lo es. */
export function isSecretConfigKey(key: string): boolean {
  if (PUBLIC_CONFIG_KEYS.has(key)) return false;
  return !PUBLIC_CONFIG_PATTERNS.some((re) => re.test(key));
}

/** Por debajo de este largo no se muestra ningún carácter: 4 de 8 ya son media clave. */
export const MASK_MIN_LENGTH = 16;
export const MASK = "••••";

/**
 * Representación visible de un secreto: `••••1234` (últimos 4) si es largo, `••••` si es corto,
 * `null` si no hay valor. Nunca más de 4 caracteres reales.
 */
export function maskSecret(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  return v.length >= MASK_MIN_LENGTH ? `${MASK}${v.slice(-4)}` : MASK;
}

export type ConfigEntryView =
  | { readonly secret: false; readonly value: string | null }
  | { readonly secret: true; readonly set: boolean; readonly masked: string | null };

/**
 * Lo único que una respuesta o una página puede mandar al navegador sobre una clave: el valor
 * si es pública; `set` + enmascarado si es secreta. Función pura (el test afirma que ningún
 * valor secreto sale de acá).
 */
export function configEntryView(key: string, value: string | null | undefined): ConfigEntryView {
  if (isSecretConfigKey(key)) {
    const masked = maskSecret(value);
    return { secret: true, set: masked !== null, masked };
  }
  const v = value ?? null;
  return { secret: false, value: v === "" ? null : v };
}

export function configView<K extends string>(
  values: Partial<Record<K, string | null | undefined>>,
  keys: readonly K[]
): Record<K, ConfigEntryView> {
  const out = {} as Record<K, ConfigEntryView>;
  for (const k of keys) out[k] = configEntryView(k, values[k]);
  return out;
}

// ── Quién escribe qué ─────────────────────────────────────────────────────────────
// `configuracion` escribe cualquier clave. `contenido` solo lo que su vista edita (la política
// de Dreams en /dreams). `operacion`, nada. Un alcance que no aparece acá no escribe nada.
const WRITABLE_BY: Readonly<Record<Exclude<Scope, "configuracion">, ReadonlySet<string>>> = {
  contenido: new Set(["DREAMS_AUTO_ACTIVATE", "DREAMS_FREQUENCY", "DREAMS_RESUMED_AT"]),
  operacion: new Set(),
};

/** Claves de `keys` que este alcance NO puede escribir (vacío = puede todas). */
export function configKeysDenied(scope: Scope, keys: readonly string[]): string[] {
  if (scope === "configuracion") return [];
  const allowed = WRITABLE_BY[scope] ?? new Set<string>();
  return keys.filter((k) => !allowed.has(k));
}

// ── Inputs de secretos: se REEMPLAZAN, nunca se rellenan con el valor actual ──────────
// El formulario manda el input vacío (el valor actual no se conoce en el navegador): vacío
// significa «conservar»; borrar es una acción explícita aparte.
export type SecretInputAction =
  | { readonly action: "keep" }
  | { readonly action: "clear" }
  | { readonly action: "set"; readonly value: string };

export function secretInputAction(input: string | null | undefined, clear: boolean): SecretInputAction {
  if (clear) return { action: "clear" };
  const v = (input ?? "").trim();
  return v ? { action: "set", value: v } : { action: "keep" };
}
