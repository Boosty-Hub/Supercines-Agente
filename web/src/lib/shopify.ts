// server-only: valida la conexión a Shopify y normaliza el dominio. El agente usa
// Shopify vía las tools internas (edge); acá solo validamos al conectar desde el
// dashboard. Conexión single-tenant. Dos modos de auth:
//   - Apps nuevas (Dev Dashboard, desde 2026): client credentials grant —
//     SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET se canjean por un access token
//     que expira a las 24h; lo cacheamos en memoria y lo renovamos solo.
//   - Apps legacy (custom app del admin): SHOPIFY_ACCESS_TOKEN estático (shpat_).
import { configValues } from "@/lib/runtime-config";

export const DEFAULT_SHOPIFY_API_VERSION = "2025-10";

// "https://Tienda.myshopify.com/" → "tienda.myshopify.com". Acepta solo el slug y
// le agrega .myshopify.com si el operador pegó solo eso.
export function normalizeShopDomain(raw: string): string {
  let d = (raw || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\/$/, "");
  if (d && !d.includes(".")) d = `${d}.myshopify.com`;
  return d;
}

// ---- Client credentials grant (apps del Dev Dashboard, 2026+) ----

// Canjea client_id + client_secret por un access token de 24h.
export async function exchangeShopifyToken(
  domain: string,
  clientId: string,
  clientSecret: string
): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; error: string }> {
  const d = normalizeShopDomain(domain);
  try {
    const res = await fetch(`https://${d}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      cache: "no-store",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      if (res.status === 401 || res.status === 400) {
        return {
          ok: false,
          error:
            "Shopify rechazó las credenciales. Verificá Client ID/Secret, que la app esté instalada en la tienda y que tienda y app sean de la misma organización.",
        };
      }
      return { ok: false, error: `Shopify respondió ${res.status}: ${detail}` };
    }
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return { ok: false, error: "Shopify no devolvió un access token." };
    const expiresIn = typeof j.expires_in === "number" ? j.expires_in : 86399;
    return { ok: true, token: j.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Cache en memoria del token canjeado (dura 24h; renovamos con 5 min de margen).
let tokenCache: { key: string; token: string; expiresAt: number } | null = null;
// Dedup de canjes concurrentes: N requests simultáneos → 1 solo exchange.
let inFlight: Promise<Awaited<ReturnType<typeof exchangeShopifyToken>>> | null = null;

/**
 * Resuelve el access token vigente según la config: token estático legacy si
 * existe, si no client credentials (con cache). Devuelve null si Shopify no
 * está conectado.
 */
export async function getShopifyAccessToken(): Promise<
  | { domain: string; token: string; version: string }
  | null
> {
  const {
    SHOPIFY_STORE_DOMAIN: domain,
    SHOPIFY_ACCESS_TOKEN: staticToken,
    SHOPIFY_CLIENT_ID: clientId,
    SHOPIFY_CLIENT_SECRET: clientSecret,
    SHOPIFY_API_VERSION: ver,
  } = await configValues([
    "SHOPIFY_STORE_DOMAIN",
    "SHOPIFY_ACCESS_TOKEN",
    "SHOPIFY_CLIENT_ID",
    "SHOPIFY_CLIENT_SECRET",
    "SHOPIFY_API_VERSION",
  ]);
  if (!domain) return null;
  const version = ver || DEFAULT_SHOPIFY_API_VERSION;

  if (staticToken) return { domain, token: staticToken, version };
  if (!clientId || !clientSecret) return null;

  // La key incluye un sufijo del secret: si se rota el secret, el token viejo
  // cacheado deja de servirse de inmediato.
  const key = `${domain}:${clientId}:${clientSecret.slice(-8)}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt - 300_000 > Date.now()) {
    return { domain, token: tokenCache.token, version };
  }
  if (!inFlight) {
    inFlight = exchangeShopifyToken(domain, clientId, clientSecret).finally(() => {
      inFlight = null;
    });
  }
  const r = await inFlight;
  if (!r.ok) {
    // "no conectado" y "credenciales rotas" no deben verse iguales en los logs.
    console.warn("Shopify token exchange failed:", r.error);
    return null;
  }
  tokenCache = { key, token: r.token, expiresAt: r.expiresAt };
  return { domain, token: r.token, version };
}

export async function validateShopifyConnection(
  domain: string,
  token: string,
  version: string = DEFAULT_SHOPIFY_API_VERSION
): Promise<{ ok: boolean; shopName?: string; error?: string }> {
  const d = normalizeShopDomain(domain);
  if (!d) return { ok: false, error: "Falta el dominio de la tienda (xxx.myshopify.com)." };
  if (!token) return { ok: false, error: "Falta el token de Shopify." };

  try {
    const res = await fetch(`https://${d}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ query: "{ shop { name myshopifyDomain } }" }),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Token inválido o sin permisos. Revisá los scopes de la app." };
    }
    if (!res.ok) return { ok: false, error: `Shopify respondió ${res.status}.` };
    const j = (await res.json()) as {
      data?: { shop?: { name?: string } };
      errors?: Array<{ message: string }>;
    };
    if (j.errors?.length) return { ok: false, error: j.errors[0].message };
    return { ok: true, shopName: j.data?.shop?.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Scopes REALES concedidos a la app en la tienda (lo que el token trae de verdad,
// no lo que la config de la app pide). Sirve para avisar en el dashboard si se
// activa una tool sin permiso. Devuelve null si Shopify no está conectado o si
// el token falla; el error queda en `error` para mostrarlo.
export async function getShopifyScopes(): Promise<{
  ok: boolean;
  scopes: string[];
  shopName?: string;
  error?: string;
}> {
  const creds = await getShopifyAccessToken();
  if (!creds) return { ok: false, scopes: [], error: "Shopify no está conectado." };
  try {
    const res = await fetch(`https://${creds.domain}/admin/api/${creds.version}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": creds.token, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        query: "{ shop { name } currentAppInstallation { accessScopes { handle } } }",
      }),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, scopes: [], error: "Token inválido o sin permisos." };
    }
    if (!res.ok) return { ok: false, scopes: [], error: `Shopify respondió ${res.status}.` };
    const j = (await res.json()) as {
      data?: {
        shop?: { name?: string };
        currentAppInstallation?: { accessScopes?: Array<{ handle: string }> };
      };
      errors?: Array<{ message: string }>;
    };
    if (j.errors?.length) return { ok: false, scopes: [], error: j.errors[0].message };
    const scopes = (j.data?.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle);
    return { ok: true, scopes, shopName: j.data?.shop?.name };
  } catch (e) {
    return { ok: false, scopes: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// Estado de conexión para el dashboard (¿hay credenciales guardadas?).
export async function getShopifyStatus(): Promise<{
  configured: boolean;
  domain: string | null;
}> {
  const {
    SHOPIFY_STORE_DOMAIN: domain,
    SHOPIFY_ACCESS_TOKEN: token,
    SHOPIFY_CLIENT_ID: clientId,
    SHOPIFY_CLIENT_SECRET: clientSecret,
  } = await configValues([
    "SHOPIFY_STORE_DOMAIN",
    "SHOPIFY_ACCESS_TOKEN",
    "SHOPIFY_CLIENT_ID",
    "SHOPIFY_CLIENT_SECRET",
  ]);
  const hasAuth = Boolean(token) || Boolean(clientId && clientSecret);
  return { configured: Boolean(domain && hasAuth), domain: domain || null };
}
