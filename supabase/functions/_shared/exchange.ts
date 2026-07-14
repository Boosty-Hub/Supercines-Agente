// _shared/exchange.ts
// Tasa de cambio USD→VES (BCV) para la tool interna `tasa_bcv`.
//
// Fuente en orden de precedencia:
//   1. runtime_config.BCV_RATE_URL — endpoint propio del operador. Si existe
//      BCV_RATE_APIKEY se manda como `apikey` + `Authorization: Bearer`.
//      Acepta los formatos de respuesta más comunes: [{rate,source}], {rate},
//      {promedio} (dolarapi), {price} (pydolarve).
//   2. Fallback público sin credenciales: ve.dolarapi.com (tasa oficial BCV).
//
// Cache en module scope con TTL 6h — el BCV publica la tasa una vez al día;
// no tiene sentido golpear la fuente en cada mensaje.

import type { ConfigReader } from "./config.ts";

export type BcvRate = { rate: number; source: string; fetchedAt: string };

const DEFAULT_URL = "https://ve.dolarapi.com/v1/dolares/oficial";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache: { key: string; value: BcvRate; loadedAt: number } | null = null;

// Extrae el primer número de tasa razonable de los formatos conocidos.
// deno-lint-ignore no-explicit-any
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

export async function getBcvRate(cfg: ConfigReader): Promise<BcvRate> {
  const customUrl = cfg.get("BCV_RATE_URL");
  const apiKey = cfg.get("BCV_RATE_APIKEY");
  const url = customUrl || DEFAULT_URL;

  if (cache && cache.key === url && Date.now() - cache.loadedAt < TTL_MS) {
    return cache.value;
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (customUrl && apiKey) {
    headers["apikey"] = apiKey;
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    // Si la fuente custom falla y no ERA el fallback, intentar el público.
    if (customUrl) {
      console.warn(`BCV_RATE_URL respondió ${res.status}; usando fallback público.`);
      const fb = await fetch(DEFAULT_URL, { headers: { Accept: "application/json" } });
      if (!fb.ok) throw new Error(`No pude obtener la tasa BCV (custom ${res.status}, fallback ${fb.status}).`);
      const parsed = parseRate(await fb.json());
      if (!parsed) throw new Error("La fuente pública de tasa BCV devolvió un formato desconocido.");
      const value: BcvRate = { ...parsed, fetchedAt: new Date().toISOString() };
      // Cachear bajo la KEY DEL FALLBACK, no la custom: así la próxima
      // invocación reintenta el endpoint del operador en vez de servir
      // silenciosamente la fuente pública durante 6h.
      cache = { key: DEFAULT_URL, value, loadedAt: Date.now() };
      return value;
    }
    throw new Error(`No pude obtener la tasa BCV (${res.status}).`);
  }

  const parsed = parseRate(await res.json());
  if (!parsed) throw new Error("La fuente de tasa BCV devolvió un formato desconocido.");
  const value: BcvRate = { ...parsed, fetchedAt: new Date().toISOString() };
  cache = { key: url, value, loadedAt: Date.now() };
  return value;
}
