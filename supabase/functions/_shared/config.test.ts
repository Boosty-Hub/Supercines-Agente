// Lector de runtime_config: DB-first/env-fallback (get) y SOLO la base (getDbOnly).
import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { createConfigReader } from "./config.ts";

const ENV: Record<string, string> = {
  SOLO_ENV: "del-entorno",
  AMBOS: "env-pierde",
  VACIO_EN_DB: "env-gana",
  SUPABASE_SERVICE_ROLE_KEY: "eyJ-SERVICE",
};
const envGet = (k: string) => (Object.hasOwn(ENV, k) ? ENV[k] : undefined);

function mapOf(rows: Record<string, string>): Record<string, string> {
  const m: Record<string, string> = Object.create(null);
  Object.assign(m, rows);
  return m;
}

Deno.test("get: la base gana; vacío o ausente en la base cae al entorno", () => {
  const cfg = createConfigReader(mapOf({ AMBOS: "db-gana", VACIO_EN_DB: "   " }), envGet);
  assertEquals(cfg.get("AMBOS"), "db-gana");
  assertEquals(cfg.get("SOLO_ENV"), "del-entorno");
  assertEquals(cfg.get("VACIO_EN_DB"), "env-gana");
  assertEquals(cfg.get("NADA"), undefined);
  assertEquals(cfg.getOr("NADA", "x"), "x");
  assertThrows(() => cfg.require("NADA"));
});

Deno.test("getDbOnly: SOLO la tabla, nunca el entorno (un secret de las funciones no se filtra por un {{CLAVE}})", () => {
  const cfg = createConfigReader(mapOf({ AMBOS: "db", VACIO_EN_DB: "" }), envGet);
  assertEquals(cfg.getDbOnly("AMBOS"), "db");
  assertEquals(cfg.getDbOnly("SOLO_ENV"), undefined);
  assertEquals(cfg.getDbOnly("SUPABASE_SERVICE_ROLE_KEY"), undefined);
  assertEquals(cfg.getDbOnly("VACIO_EN_DB"), undefined);
});

Deno.test("getDbOnly: claves heredadas de Object.prototype no resuelven", () => {
  const plain = { REAL: "v" } as Record<string, string>; // mapa CON prototipo: igual no hereda
  const cfg = createConfigReader(plain, () => undefined);
  for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assertEquals(cfg.getDbOnly(k), undefined, k);
    assertEquals(cfg.get(k), undefined, k);
  }
  assertEquals(cfg.getDbOnly("REAL"), "v");
});

Deno.test("los secretos atados a un destino NO tienen fallback al entorno (solo runtime_config)", () => {
  const env: Record<string, string> = {
    KOMMO_ACCESS_TOKEN: "del-entorno",
    SHOPIFY_ACCESS_TOKEN: "del-entorno",
    BCV_RATE_APIKEY: "del-entorno",
    TOOL_ERP: "del-entorno",
    TOOL_ERP_HOSTS: "api.erp.com",
    OPENAI_API_KEY: "del-entorno",
  };
  const cfg = createConfigReader(mapOf({}), (k) => env[k]);
  for (const k of ["KOMMO_ACCESS_TOKEN", "SHOPIFY_ACCESS_TOKEN", "BCV_RATE_APIKEY", "TOOL_ERP"]) {
    assertEquals(cfg.get(k), undefined, k);
    assertEquals(cfg.getOr(k, "x"), "x", k);
  }
  // lo que NO es un secreto atado sigue con DB-first / env-fallback
  assertEquals(cfg.get("OPENAI_API_KEY"), "del-entorno");
  assertEquals(cfg.get("TOOL_ERP_HOSTS"), "api.erp.com");
  // con valor en la base sí se resuelve
  const conDb = createConfigReader(mapOf({ KOMMO_ACCESS_TOKEN: "de-la-base" }), (k) => env[k]);
  assertEquals(conDb.get("KOMMO_ACCESS_TOKEN"), "de-la-base");
});
