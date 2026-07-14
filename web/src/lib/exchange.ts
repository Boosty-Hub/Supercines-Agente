// server-only: tasa USD→VES (BCV) para el badge del dashboard. Espejo del
// resolver de las Edge Functions (supabase/functions/_shared/exchange.ts):
// misma precedencia de fuente (BCV_RATE_URL custom → fallback público) y el
// mismo cache de 6h en module scope. Nunca lanza: si la fuente falla devuelve
// null y el dashboard simplemente no muestra el badge.
import { configValues } from "@/lib/runtime-config";

export type BcvRate = { rate: number; source: string; fetchedAt: string };

const DEFAULT_URL = "https://ve.dolarapi.com/v1/dolares/oficial";
const TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3500; // el dashboard nunca se cuelga por la tasa

let cache: { key: string; value: BcvRate; loadedAt: number } | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseRate(body: any): { rate: number; source: string } | null {
  const candidate = Array.isArray(body) ? body[0] : body;
  if (!candidate || typeof candidate !== "object") return null;
  for (const key of ["rate", "promedio", "price", "valor", "venta"]) {
    const n = Number(candidate[key]);
    if (Number.isFinite(n) && n > 0) {
      return { rate: n, source: String(candidate.source ?? candidate.fuente ?? "BCV") };
    }
  }
  return null;
}

async function fetchRate(url: string, apiKey?: string): Promise<BcvRate | null> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) {
      headers["apikey"] = apiKey;
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const res = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const parsed = parseRate(await res.json());
    if (!parsed) return null;
    return { ...parsed, fetchedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

export async function getBcvRateCached(): Promise<BcvRate | null> {
  const { BCV_RATE_URL: customUrl, BCV_RATE_APIKEY: apiKey } = await configValues([
    "BCV_RATE_URL",
    "BCV_RATE_APIKEY",
  ]);
  const key = customUrl || DEFAULT_URL;

  if (cache && cache.key === key && Date.now() - cache.loadedAt < TTL_MS) {
    return cache.value;
  }

  let value = await fetchRate(key, customUrl ? apiKey : undefined);
  let cacheKey = key;
  if (!value && customUrl) {
    // Fuente custom caída → fallback público, cacheado bajo SU key para que
    // la próxima pasada reintente el endpoint del operador.
    value = await fetchRate(DEFAULT_URL);
    cacheKey = DEFAULT_URL;
  }
  if (!value) return null;

  cache = { key: cacheKey, value, loadedAt: Date.now() };
  return value;
}
