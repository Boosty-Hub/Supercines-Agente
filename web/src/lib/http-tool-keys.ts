// Resolución de {{CLAVE}} en los headers de las http tools, con cada secreto ATADO a sus hosts.
//
// SEGURIDAD: el valor resuelto se manda a la URL que la tool define, y la URL la define quien
// edita la tool (o el modelo, vía {{param}}). Una lista de claves permitidas no alcanza: una
// tool con url https://atacante.com y header «Bearer {{KOMMO_ACCESS_TOKEN}}» exfiltra el
// secreto en cuanto el agente la llama. Por eso, además de la lista:
//   - KOMMO_ACCESS_TOKEN solo viaja al host EXACTO de KOMMO_API_DOMAIN (https).
//   - TOOL_<X> (secretos que el operador crea para sus tools) solo viajan a los hosts que el
//     operador declara junto al secreto en TOOL_<X>_HOSTS (lista separada por comas, host exacto);
//     sin esa declaración no se resuelven.
//   - KOMMO_API_DOMAIN / KOMMO_SUBDOMAIN no son secretos: se resuelven como DATO, sin atar.
//   - ANTHROPIC_API_KEY y cualquier otra credencial (SUPABASE_*, etc.) NO se resuelven nunca
//     (ninguna tool legítima las usa: verificado en migraciones y seeds).
//   - La decisión se toma con la URL FINAL ya interpolada y, si el host de la plantilla tiene
//     un {{param}}, se PROHÍBEN los secretos (el modelo no puede mover el host).
//   - Una clave no permitida, un host no atado, un secreto sin valor o un host con {{param}} +
//     secreto RECHAZAN la llamada con un error claro (nunca se manda el header vacío en silencio).
//
// SIN «PARSER DIFFERENTIAL»: la URL se parsea UNA vez (`parseToolUrl`), el host se valida sobre
// ESE objeto y el fetch se hace con `url.href` (lo que devuelve `resolveToolHeaders` en `url`),
// nunca con la cadena original. Antes de parsear se rechaza todo lo que dos parsers leen distinto
// (backslash, espacios y controles, no-ASCII, %00, `%` / `@` / corchetes en la autoridad) y, con
// un secreto en juego, además: puertos distintos de 443, IPs literales en cualquier notación
// (decimal, octal, hexadecimal, abreviada, IPv6), hosts de una sola etiqueta y `localhost`,
// etiquetas inválidas (punto final, vacías). Se exige ASCII: un host con punycode solo coincide
// si el operador declaró exactamente ese `xn--…`; y `url.hostname` debe ser idéntico al host
// escrito en la URL (si el parser lo reescribe, es un diferencial → rechazo).
// Quien haga el fetch con secretos debe usar redirect: "manual" (un 302 no puede llevar el
// header a otro host): `resolveToolHeaders` lo indica en `hasSecret`.
// Esta es la copia de la web; supabase/functions/_shared/http-tool-keys.ts es idéntica
// (http-tool-keys.test.ts lo verifica) y la usa generate-response.

export const HTTP_TOOL_DATA_KEYS = ["KOMMO_API_DOMAIN", "KOMMO_SUBDOMAIN"] as const;
export const HTTP_TOOL_KOMMO_SECRET = "KOMMO_ACCESS_TOKEN";

const CUSTOM_SECRET_RE = /^TOOL_[A-Z0-9_]{1,64}$/;
const HOSTS_SUFFIX = "_HOSTS";
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;
const MAX_URL_LENGTH = 4096;

export type ToolHeader = { name: string; value: string };

export type HeaderResolution =
  | { ok: true; url: string; headers: Record<string, string>; hasSecret: boolean }
  | { ok: false; error: string };

export type ToolUrlParse = { ok: true; url: URL } | { ok: false; error: string };

/** Clave de secreto personalizada (TOOL_X); la declaración de hosts (TOOL_X_HOSTS) NO es un secreto. */
export function isCustomSecretKey(key: string): boolean {
  return CUSTOM_SECRET_RE.test(key) && !key.endsWith(HOSTS_SUFFIX);
}

/** ¿Es un secreto resoluble en headers? (KOMMO_ACCESS_TOKEN o TOOL_X). */
export function isToolSecretKey(key: string): boolean {
  return key === HTTP_TOOL_KOMMO_SECRET || isCustomSecretKey(key);
}

/** Claves de runtime_config que el resolvedor puede necesitar leer (secretos, hosts y datos). */
export function isToolConfigKey(key: string): boolean {
  return (
    key === HTTP_TOOL_KOMMO_SECRET ||
    (HTTP_TOOL_DATA_KEYS as readonly string[]).includes(key) ||
    CUSTOM_SECRET_RE.test(key) // TOOL_X y TOOL_X_HOSTS
  );
}

/** Placeholders {{CLAVE}} de los headers, sin repetir y en orden de aparición. */
export function headerPlaceholders(headers: ToolHeader[] | null | undefined): string[] {
  const out: string[] = [];
  for (const h of headers ?? []) {
    for (const m of String(h?.value ?? "").matchAll(PLACEHOLDER_RE)) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

/** Secretos que usan los headers (los que el probador pide tipear a mano). */
export function secretKeysInHeaders(headers: ToolHeader[] | null | undefined): string[] {
  return headerPlaceholders(headers).filter(isToolSecretKey);
}

/**
 * Claves NO secretas que hacen falta para resolver estos headers: los datos
 * (KOMMO_API_DOMAIN/KOMMO_SUBDOMAIN, también host del token de Kommo) y los TOOL_X_HOSTS.
 */
export function publicKeysForHeaders(headers: ToolHeader[] | null | undefined): string[] {
  const keys = new Set<string>();
  for (const k of headerPlaceholders(headers)) {
    if ((HTTP_TOOL_DATA_KEYS as readonly string[]).includes(k)) keys.add(k);
    else if (k === HTTP_TOOL_KOMMO_SECRET) keys.add("KOMMO_API_DOMAIN");
    else if (isCustomSecretKey(k)) keys.add(k + HOSTS_SUFFIX);
  }
  return [...keys];
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Host al que se le puede atar un secreto: ASCII en minúsculas, ≥ 2 etiquetas válidas (sin
 * punto final ni etiquetas vacías), TLD que empieza con letra (descarta toda IP literal:
 * `2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1`, IPv6) y nunca `localhost`.
 */
export function isBindableHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  if (!TLD_RE.test(labels[labels.length - 1])) return false;
  if (labels[labels.length - 1] === "localhost") return false;
  return true;
}

/** Host normalizado (minúsculas, sin esquema, sin ruta ni puerto 443) o null si no es atable. */
export function normalizeHost(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let h = raw.trim().toLowerCase().replace(/^https:\/\//, "");
  h = h.split(/[/?#]/)[0].replace(/:443$/, "");
  return isBindableHost(h) ? h : null;
}

// Caracteres que distintos parsers interpretan distinto (o que no tienen uso legítimo en la URL
// de una tool): todo lo que no sea ASCII imprimible sin espacio, y el backslash.
const RAW_URL_RE = /^[\x21-\x5b\x5d-\x7e]+$/;
// Autoridad permitida: host en [A-Za-z0-9.-] y puerto opcional. Sin `@` (userinfo), sin `%`
// (un host percent-encoded se decodifica distinto según el parser), sin corchetes (IPv6).
const AUTHORITY_RE = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/;

/**
 * Parsea la URL FINAL de una tool UNA sola vez. `strict` (hay un secreto en los headers) exige
 * además un host atable (`isBindableHost`) y el puerto 443. El llamador debe hacer el fetch
 * con `url.href`, nunca con `raw`.
 */
export function parseToolUrl(raw: string, opts: { strict: boolean }): ToolUrlParse {
  const bad = (error: string): ToolUrlParse => ({ ok: false, error });
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return bad("URL vacía o demasiado larga");
  if (!RAW_URL_RE.test(raw)) {
    return bad("la URL tiene caracteres no permitidos (espacios, controles, backslash o no-ASCII): codificalos con %XX");
  }
  if (/%00/.test(raw)) return bad("la URL no puede contener %00");
  if (!raw.startsWith("https://")) return bad("la URL debe empezar con https://");
  const rest = raw.slice("https://".length);
  const authority = rest.split(/[/?#]/, 1)[0];
  const m = AUTHORITY_RE.exec(authority);
  if (!m) return bad("el host de la URL no es válido (sin usuario@, %, corchetes ni caracteres raros)");
  const host = m[1].toLowerCase();
  const port = m[2];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad("la URL no es válida");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return bad("la URL debe ser https sin usuario");
  // Lo que el parser entiende como host tiene que ser EXACTAMENTE lo escrito: si lo reescribe
  // (IP abreviada, punycode, etc.) es un diferencial.
  if (url.hostname !== host) return bad(`el host de la URL es ambiguo (${host})`);
  if (opts.strict) {
    if (!isBindableHost(host)) {
      return bad(`un secreto no se envía a ${host}: hace falta un dominio (no una IP, localhost ni un host de una sola parte)`);
    }
    if (port !== undefined && port !== "443") return bad("un secreto solo se envía al puerto 443");
    if (url.port !== "") return bad("un secreto solo se envía al puerto 443");
  }
  return { ok: true, url };
}

function parseHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((x) => normalizeHost(x))
    .filter((x): x is string => x !== null);
}

/**
 * Resuelve los headers de una http tool y valida su URL. `finalUrl` es la URL YA interpolada
 * ({{param}} del modelo incluido); `urlTemplate`, la plantilla original (para detectar {{param}}
 * en el host). `lookup` es la ÚNICA fuente de valores (runtime_config en el runtime; en el
 * probador, los valores tecleados a mano para los secretos — nunca process.env).
 * `missingSecret` arma el error cuando un secreto no tiene valor. En `ok` devuelve la `url`
 * normalizada con la que HAY que hacer el fetch.
 */
export function resolveToolHeaders(opts: {
  headers: ToolHeader[] | null | undefined;
  urlTemplate: string;
  finalUrl: string;
  lookup: (key: string) => string | undefined;
  missingSecret?: (key: string) => string;
}): HeaderResolution {
  const keys = headerPlaceholders(opts.headers);
  for (const k of keys) {
    if (!(HTTP_TOOL_DATA_KEYS as readonly string[]).includes(k) && !isToolSecretKey(k)) {
      return { ok: false, error: `la clave {{${k}}} no se puede usar en headers de una tool` };
    }
  }
  const secrets = keys.filter(isToolSecretKey);
  const hasSecret = secrets.length > 0;

  const parsed = parseToolUrl(opts.finalUrl, { strict: hasSecret });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const url = parsed.url;

  const values: Record<string, string> = Object.create(null);
  for (const k of keys) {
    if (!isToolSecretKey(k)) {
      values[k] = opts.lookup(k) ?? "";
      continue;
    }
    let allowed: string[];
    if (k === HTTP_TOOL_KOMMO_SECRET) {
      const d = normalizeHost(opts.lookup("KOMMO_API_DOMAIN"));
      allowed = d ? [d] : [];
    } else {
      allowed = parseHosts(opts.lookup(k + HOSTS_SUFFIX));
      if (allowed.length === 0) {
        return { ok: false, error: `el secreto {{${k}}} no tiene hosts permitidos: declará ${k}${HOSTS_SUFFIX} en la configuración` };
      }
    }
    // Es un secreto: tiene que ir a un host atado, con la URL final ya parseada.
    if (/^https:\/\/[^/?#]*\{\{/i.test(opts.urlTemplate)) {
      return { ok: false, error: `una tool con {{param}} en el host de la URL no puede usar secretos ({{${k}}})` };
    }
    if (!allowed.includes(url.hostname)) {
      return { ok: false, error: `el secreto {{${k}}} no se puede enviar a ${url.hostname}` };
    }
    const v = opts.lookup(k);
    if (v === undefined || v.trim() === "") {
      return { ok: false, error: opts.missingSecret ? opts.missingSecret(k) : `el secreto {{${k}}} no está configurado` };
    }
    values[k] = v;
  }

  const out: Record<string, string> = {};
  for (const h of opts.headers ?? []) {
    out[h.name] = h.value.replace(PLACEHOLDER_RE, (_, k: string) => values[k] ?? "");
  }
  return { ok: true, url: url.href, headers: out, hasSecret };
}
