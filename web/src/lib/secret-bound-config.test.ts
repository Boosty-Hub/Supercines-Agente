// Pares destino + secreto: cambiar el destino exige reenviar (o borrar) el secreto.
// Correr con: cd web && node --test src/lib/secret-bound-config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkSecretBindings, keysToCheck, pairForDestinationKey, SECRET_BOUND_PAIRS } from "./secret-bound-config.ts";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const lookupIn = (m: Record<string, string>) => (k: string) => (Object.hasOwn(m, k) ? m[k] : undefined);
const NO_ENV = () => undefined;

const CURRENT: Record<string, string> = {
  BCV_RATE_URL: "https://tasas.miempresa.com/rpc/get_rate?from=USD",
  BCV_RATE_APIKEY: "bcv-SECRETO",
  KOMMO_API_DOMAIN: "cliente.kommo.com",
  KOMMO_ACCESS_TOKEN: "kommo-SECRETO",
  SHOPIFY_STORE_DOMAIN: "tienda.myshopify.com",
  SHOPIFY_CLIENT_ID: "cid",
  SHOPIFY_CLIENT_SECRET: "shpss-SECRETO",
  TOOL_ERP: "erp-SECRETO",
  TOOL_ERP_HOSTS: "api.erp.com",
};
const check = (write: Record<string, string | null | undefined>, current = CURRENT, env: (k: string) => string | undefined = NO_ENV) =>
  checkSecretBindings(write, lookupIn(current), env);

// ── BCV ────────────────────────────────────────────────────────────────────────
test("BCV: cambiar el HOST de BCV_RATE_URL sin reenviar la key → violación", () => {
  const v = check({ BCV_RATE_URL: "https://atacante.com/rate" });
  assert.equal(v.length, 1);
  assert.equal(v[0].destinationKey, "BCV_RATE_URL");
  assert.deepEqual(v[0].secretKeys, ["BCV_RATE_APIKEY"]);
  assert.ok(!JSON.stringify(v).includes("SECRETO"), "el mensaje no filtra el secreto");
});

test("BCV: cambiar el host reenviando la key, o borrándola, está permitido", () => {
  assert.deepEqual(check({ BCV_RATE_URL: "https://otra.com/rate", BCV_RATE_APIKEY: "nueva" }), []);
  assert.deepEqual(check({ BCV_RATE_URL: "https://otra.com/rate", BCV_RATE_APIKEY: "" }), []);
  assert.deepEqual(check({ BCV_RATE_URL: "https://otra.com/rate", BCV_RATE_APIKEY: null }), []);
});

test("BCV: misma origin con otra ruta/query no exige nada; puerto u esquema distinto sí", () => {
  assert.deepEqual(check({ BCV_RATE_URL: "https://TASAS.miempresa.com/otra?x=1" }), []);
  assert.equal(check({ BCV_RATE_URL: "https://tasas.miempresa.com:8443/rpc" }).length, 1);
  assert.equal(check({ BCV_RATE_URL: "http://tasas.miempresa.com/rpc" }).length, 1);
  assert.equal(check({ BCV_RATE_URL: "no es url" }).length, 1, "destino ilegible = destino nuevo");
});

test("BCV: quitar la URL (vuelve a la fuente pública, que no lleva key) no exige nada", () => {
  assert.deepEqual(check({ BCV_RATE_URL: "" }), []);
});

test("BCV: si la key viene del entorno, borrarla en la base no alcanza (el entorno la seguiría mandando)", () => {
  const current = { ...CURRENT };
  delete (current as Record<string, string>).BCV_RATE_APIKEY;
  const env = lookupIn({ BCV_RATE_APIKEY: "env-SECRETO" });
  const vigente = (k: string) => lookupIn(current)(k) ?? env(k);
  assert.equal(checkSecretBindings({ BCV_RATE_URL: "https://otra.com", BCV_RATE_APIKEY: "" }, vigente, env).length, 1);
  assert.deepEqual(checkSecretBindings({ BCV_RATE_URL: "https://otra.com", BCV_RATE_APIKEY: "nueva" }, vigente, env), []);
});

test("BCV: primera configuración (sin URL ni key previas) o sin key vigente no exige nada", () => {
  assert.deepEqual(check({ BCV_RATE_URL: "https://otra.com/rate" }, {}), []);
  assert.deepEqual(check({ BCV_RATE_URL: "https://otra.com/rate", BCV_RATE_APIKEY: "k" }, {}), []);
});

// ── Kommo ──────────────────────────────────────────────────────────────────────
test("Kommo: mover KOMMO_API_DOMAIN exige reenviar KOMMO_ACCESS_TOKEN", () => {
  assert.equal(check({ KOMMO_API_DOMAIN: "atacante.com" }).length, 1);
  assert.equal(check({ KOMMO_API_DOMAIN: "otro.kommo.com", KOMMO_SUBDOMAIN: "otro" }).length, 1);
  assert.deepEqual(check({ KOMMO_API_DOMAIN: "otro.kommo.com", KOMMO_ACCESS_TOKEN: "nuevo" }), []);
  assert.deepEqual(check({ KOMMO_API_DOMAIN: "Cliente.Kommo.com" }), [], "mismo host normalizado");
  assert.deepEqual(check({ KOMMO_ACCESS_TOKEN: "rotado" }), [], "rotar solo el token no es cambiar el destino");
});

// ── Shopify ────────────────────────────────────────────────────────────────────
test("Shopify: cambiar la tienda exige reenviar (o borrar) TODAS las credenciales vigentes", () => {
  const v = check({ SHOPIFY_STORE_DOMAIN: "otra.myshopify.com" });
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].secretKeys, ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"]);
  // solo el secret reenviado, el client id viejo queda → sigue violando
  assert.deepEqual(check({ SHOPIFY_STORE_DOMAIN: "otra.myshopify.com", SHOPIFY_CLIENT_SECRET: "n" })[0].secretKeys, ["SHOPIFY_CLIENT_ID"]);
  // lo que hace /api/shopify/connect: todo junto
  assert.deepEqual(
    check({ SHOPIFY_STORE_DOMAIN: "otra.myshopify.com", SHOPIFY_CLIENT_ID: "c", SHOPIFY_CLIENT_SECRET: "s", SHOPIFY_ACCESS_TOKEN: "" }),
    []
  );
  // desconectar: todo vacío
  assert.deepEqual(
    check({ SHOPIFY_STORE_DOMAIN: "", SHOPIFY_ACCESS_TOKEN: "", SHOPIFY_CLIENT_ID: "", SHOPIFY_CLIENT_SECRET: "" }),
    []
  );
});

// ── TOOL_<X>_HOSTS ─────────────────────────────────────────────────────────────
test("TOOL_<X>_HOSTS: agregar un host exige reenviar TOOL_<X>; quitar hosts no", () => {
  const v = check({ TOOL_ERP_HOSTS: "api.erp.com, atacante.com" });
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].secretKeys, ["TOOL_ERP"]);
  assert.deepEqual(check({ TOOL_ERP_HOSTS: "api.erp.com, atacante.com", TOOL_ERP: "nuevo" }), []);
  assert.deepEqual(check({ TOOL_ERP_HOSTS: "" }), [], "quitar todos los hosts no habilita nada");
  assert.deepEqual(check({ TOOL_ERP_HOSTS: "API.erp.com" }), []);
  assert.deepEqual(check({ TOOL_ERP_HOSTS: "api.erp.com, 127.0.0.1" }), [], "un host inválido no ata nada (el resolvedor lo ignora)");
});

test("pares y claves a consultar", () => {
  assert.deepEqual(
    SECRET_BOUND_PAIRS.map((p) => p.destinationKey),
    ["BCV_RATE_URL", "KOMMO_API_DOMAIN", "SHOPIFY_STORE_DOMAIN"]
  );
  assert.equal(pairForDestinationKey("TOOL_ERP")?.destinationKey ?? null, null, "el secreto no es un destino");
  assert.deepEqual(pairForDestinationKey("TOOL_ERP_HOSTS")?.secretKeys, ["TOOL_ERP"]);
  assert.equal(pairForDestinationKey("OPERATOR_NAME"), null);
  assert.deepEqual(keysToCheck(["OPERATOR_NAME", "BCV_RATE_APIKEY"]), [], "sin destinos tocados no se consulta nada");
  assert.deepEqual(keysToCheck(["BCV_RATE_URL"]).sort(), ["BCV_RATE_APIKEY", "BCV_RATE_URL"]);
});

test("escrituras que no tocan destinos nunca violan", () => {
  assert.deepEqual(check({ OPERATOR_NAME: "x", BCV_RATE_APIKEY: "", KOMMO_ACCESS_TOKEN: "t" }), []);
});

// ── Guardias de código: una sola implementación, aplicada en el único camino de escritura ──
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("guardia: setConfigValues aplica checkSecretBindings antes de escribir", () => {
  const src = sinComentarios(readFileSync(here("./runtime-config.ts"), "utf8"));
  const fn = src.slice(src.indexOf("export async function setConfigValues"));
  const iCheck = fn.indexOf("checkSecretBindings(");
  const iUpsert = fn.indexOf(".upsert(");
  assert.ok(iCheck > 0 && iUpsert > iCheck, "checkSecretBindings va antes del upsert");
  assert.ok(/throw new SecretBindingError/.test(fn), "una violación aborta la escritura");
});

test("guardia: la ruta de BCV valida el par en el servidor y responde 400", () => {
  const src = sinComentarios(readFileSync(here("../app/api/agent/bcv/route.ts"), "utf8"));
  assert.ok(/SecretBindingError/.test(src), "bcv: traduce la violación a un 400");
  assert.ok(/status: 400/.test(src));
});
