// Resolución de {{CLAVE}} en los headers de las http tools, con cada secreto ATADO a sus hosts.
//
// SEGURIDAD: el valor resuelto se manda a la URL que la tool define, y la URL la define quien
// edita la tool (o el modelo, vía {{param}}). Una lista de claves permitidas no alcanza: una
// tool con url https://atacante.com y header «Bearer {{KOMMO_ACCESS_TOKEN}}» exfiltra el
// secreto en cuanto el agente la llama o se prueba. Por eso, además de la lista:
//   - KOMMO_ACCESS_TOKEN solo viaja al host EXACTO de KOMMO_API_DOMAIN (https).
//   - TOOL_<X> (secretos que el operador crea para sus tools) solo viajan a los hosts que el
//     operador declara junto al secreto en TOOL_<X>_HOSTS (lista separada por comas, host exacto);
//     sin esa declaración no se resuelven.
//   - KOMMO_API_DOMAIN / KOMMO_SUBDOMAIN no son secretos: se resuelven como DATO, sin atar.
//   - ANTHROPIC_API_KEY y cualquier otra credencial (SUPABASE_*, etc.) NO se resuelven nunca
//     (ninguna tool legítima las usa: verificado en migraciones y seeds).
//   - La decisión se toma con la URL FINAL ya interpolada y, si el host de la plantilla tiene
//     un {{param}}, se PROHÍBEN los secretos (el modelo no puede mover el host).
//   - Una clave no permitida, un host no atado o un host con {{param}} + secreto RECHAZAN la
//     llamada con un error claro (nunca se manda el header vacío en silencio).
// Quien haga el fetch con secretos debe usar redirect: "manual" (un 302 no puede llevar el
// header a otro host): `resolveToolHeaders` lo indica en `hasSecret`.
// ESTA ES LA COPIA de web/src/lib/http-tool-keys.ts (idéntica desde `export const HTTP_TOOL_DATA_KEYS`;
// web/src/lib/http-tool-keys.test.ts lo verifica); la usa generate-response.

export const HTTP_TOOL_DATA_KEYS = ["KOMMO_API_DOMAIN", "KOMMO_SUBDOMAIN"] as const;
export const HTTP_TOOL_KOMMO_SECRET = "KOMMO_ACCESS_TOKEN";

const CUSTOM_SECRET_RE = /^TOOL_[A-Z0-9_]{1,64}$/;
const HOSTS_SUFFIX = "_HOSTS";

export type ToolHeader = { name: string; value: string };

export type HeaderResolution =
  | { ok: true; headers: Record<string, string>; hasSecret: boolean }
  | { ok: false; error: string };

/** Clave de secreto personalizada (TOOL_X); la declaración de hosts (TOOL_X_HOSTS) NO es un secreto. */
export function isCustomSecretKey(key: string): boolean {
  return CUSTOM_SECRET_RE.test(key) && !key.endsWith(HOSTS_SUFFIX);
}

/** Claves de runtime_config que el resolvedor puede necesitar leer (secretos, hosts y datos). */
export function isToolConfigKey(key: string): boolean {
  return (
    key === HTTP_TOOL_KOMMO_SECRET ||
    (HTTP_TOOL_DATA_KEYS as readonly string[]).includes(key) ||
    CUSTOM_SECRET_RE.test(key) // TOOL_X y TOOL_X_HOSTS
  );
}

/** Host normalizado (minúsculas, sin esquema, sin ruta ni puerto 443) o null. */
export function normalizeHost(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase().replace(/^https?:\/\//, "");
  h = h.split(/[/?#]/)[0].replace(/:443$/, "");
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) ? h : null;
}

function parseHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((x) => normalizeHost(x))
    .filter((x): x is string => x !== null);
}

/**
 * Resuelve los headers de una http tool. `finalUrl` es la URL YA interpolada ({{param}} del
 * modelo incluido); `urlTemplate`, la plantilla original (para detectar {{param}} en el host).
 * `lookup` lee runtime_config (nunca process.env).
 */
export function resolveToolHeaders(opts: {
  headers: ToolHeader[] | null | undefined;
  urlTemplate: string;
  finalUrl: string;
  lookup: (key: string) => string | undefined;
}): HeaderResolution {
  let url: URL | null = null;
  try {
    url = new URL(opts.finalUrl);
  } catch {
    url = null;
  }
  const out: Record<string, string> = {};
  let hasSecret = false;

  for (const h of opts.headers ?? []) {
    const err: { m: string | null } = { m: null };
    const value = h.value.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      if ((HTTP_TOOL_DATA_KEYS as readonly string[]).includes(k)) return opts.lookup(k) ?? "";
      let allowed: string[];
      if (k === HTTP_TOOL_KOMMO_SECRET) {
        const d = normalizeHost(opts.lookup("KOMMO_API_DOMAIN"));
        allowed = d ? [d] : [];
      } else if (isCustomSecretKey(k)) {
        allowed = parseHosts(opts.lookup(k + HOSTS_SUFFIX));
        if (allowed.length === 0) {
          err.m ??= `el secreto {{${k}}} no tiene hosts permitidos: declará ${k}${HOSTS_SUFFIX} en la configuración`;
          return "";
        }
      } else {
        err.m ??= `la clave {{${k}}} no se puede usar en headers de una tool`;
        return "";
      }
      // Es un secreto: tiene que ir a un host atado, con la URL final.
      if (/^https:\/\/[^/?#]*\{\{/i.test(opts.urlTemplate)) {
        err.m ??= `una tool con {{param}} en el host de la URL no puede usar secretos ({{${k}}})`;
        return "";
      }
      if (!url || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
        err.m ??= `el secreto {{${k}}} solo se envía por https al host declarado`;
        return "";
      }
      if (!allowed.includes(url.hostname.toLowerCase())) {
        err.m ??= `el secreto {{${k}}} no se puede enviar a ${url.hostname}`;
        return "";
      }
      hasSecret = true;
      return opts.lookup(k) ?? "";
    });
    if (err.m) return { ok: false, error: err.m };
    out[h.name] = value;
  }
  return { ok: true, headers: out, hasSecret };
}
