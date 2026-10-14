// Variables {{CLAVE}} que el PROBADOR de tools (/api/tools/test) puede
// resolver desde runtime_config en los headers.
//
// Lista cerrada y SIN SECRETOS, a propósito: el probador manda la request a la
// URL que escriba quien lo usa, así que cualquier secreto resoluble ahí
// ({{SUPABASE_SERVICE_ROLE_KEY}}, {{KOMMO_ACCESS_TOKEN}}…) se exfiltra apuntando
// la tool a una URL propia. Para probar con credenciales reales se escriben a
// mano en el header del formulario (no se persisten) o se prueba en runtime.
// Nunca se lee process.env.
export const TESTER_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "KOMMO_API_DOMAIN",
  "KOMMO_SUBDOMAIN",
  "ANTHROPIC_AGENT_ID",
]);

/** Nombres de placeholders {{X}} de los headers que el probador NO resuelve. Nunca valores. */
export function unknownHeaderPlaceholders(
  headers: ReadonlyArray<{ value: string }> | undefined
): string[] {
  const out: string[] = [];
  for (const h of headers ?? []) {
    const re = /\{\{(\w+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(h?.value ?? ""))) !== null) {
      if (!TESTER_CONFIG_KEYS.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}
