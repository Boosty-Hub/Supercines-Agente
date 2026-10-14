// Secretos de http tools atados a sus hosts (anti-exfiltración).
// Correr con: cd web && node --test src/lib/http-tool-keys.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isCustomSecretKey, isToolConfigKey, normalizeHost, resolveToolHeaders } from "./http-tool-keys.ts";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const CFG: Record<string, string> = {
  KOMMO_ACCESS_TOKEN: "kommo-SECRETO",
  KOMMO_API_DOMAIN: "cliente.kommo.com",
  KOMMO_SUBDOMAIN: "cliente",
  TOOL_ERP: "erp-SECRETO",
  TOOL_ERP_HOSTS: "api.erp.com, Backup.erp.com",
  TOOL_SIN_HOSTS: "x-SECRETO",
  SUPABASE_SERVICE_ROLE_KEY: "eyJSERVICE",
  ANTHROPIC_API_KEY: "sk-ant-SECRETO",
};
const lookup = (k: string) => (Object.hasOwn(CFG, k) ? CFG[k] : undefined);
const call = (headerValue: string, finalUrl: string, urlTemplate = finalUrl) =>
  resolveToolHeaders({ headers: [{ name: "Authorization", value: headerValue }], urlTemplate, finalUrl, lookup });

test("caso legítimo de Kommo: el token viaja al host EXACTO de KOMMO_API_DOMAIN", () => {
  const r = call("Bearer {{KOMMO_ACCESS_TOKEN}}", "https://cliente.kommo.com/api/v4/leads?x=1");
  assert.deepEqual(r, { ok: true, headers: { Authorization: "Bearer kommo-SECRETO" }, hasSecret: true });
});

test("host distinto → RECHAZO (nunca el header vacío ni el secreto)", () => {
  for (const url of [
    "https://atacante.com/x",
    "https://cliente.kommo.com.atacante.com/x", // sufijo
    "https://atacante.com/cliente.kommo.com",
    "https://otro.kommo.com/x", // subdominio hermano: match exacto
    "https://cliente.kommo.com@atacante.com/x", // userinfo: el host real es atacante.com
  ]) {
    const r = call("Bearer {{KOMMO_ACCESS_TOKEN}}", url);
    assert.equal(r.ok, false, url);
    assert.ok(!JSON.stringify(r).includes("SECRETO"), "el error no filtra el secreto");
  }
});

test("solo https, sin userinfo y sin puertos raros", () => {
  assert.equal(call("{{KOMMO_ACCESS_TOKEN}}", "http://cliente.kommo.com/x").ok, false);
  assert.equal(call("{{KOMMO_ACCESS_TOKEN}}", "https://u:p@cliente.kommo.com/x").ok, false);
  assert.equal(call("{{KOMMO_ACCESS_TOKEN}}", "https://cliente.kommo.com:8443/x").ok, false);
  assert.equal(call("{{KOMMO_ACCESS_TOKEN}}", "https://cliente.kommo.com:443/x").ok, true);
  assert.equal(call("{{KOMMO_ACCESS_TOKEN}}", "no es una url").ok, false);
});

test("host con {{param}} en la plantilla + secreto → rechazado (el modelo no puede mover el host)", () => {
  // aunque la URL final resultara coincidir, la plantilla con {{param}} en el host está prohibida
  const r = call("Bearer {{KOMMO_ACCESS_TOKEN}}", "https://cliente.kommo.com/x", "https://{{sub}}.kommo.com/x");
  assert.equal(r.ok, false);
  const r2 = call("Bearer {{KOMMO_ACCESS_TOKEN}}", "https://cliente.kommo.com/x", "https://{{host}}/x");
  assert.equal(r2.ok, false);
  // un {{param}} en la RUTA o el query sí es normal
  assert.equal(call("{{KOMMO_ACCESS_TOKEN}}", "https://cliente.kommo.com/leads/7", "https://cliente.kommo.com/leads/{{id}}").ok, true);
  // sin secretos, {{param}} en el host no molesta
  const sin = resolveToolHeaders({ headers: [{ name: "X-A", value: "fijo" }], urlTemplate: "https://{{h}}/x", finalUrl: "https://a.com/x", lookup });
  assert.equal(sin.ok, true);
});

test("ANTHROPIC_API_KEY, SUPABASE_*, y cualquier clave ajena NO se resuelven nunca (ni a su host)", () => {
  for (const k of ["ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "OPENAI_API_KEY", "PATH", "constructor", "__proto__"]) {
    const r = call(`Bearer {{${k}}}`, "https://api.anthropic.com/v1/messages");
    assert.equal(r.ok, false, k);
  }
});

test("TOOL_<X>: sin hosts declarados no se resuelve; con hosts, solo a esos (match exacto, sin importar mayúsculas)", () => {
  assert.equal(call("{{TOOL_SIN_HOSTS}}", "https://api.erp.com/x").ok, false);
  assert.equal(call("{{TOOL_NO_EXISTE}}", "https://api.erp.com/x").ok, false);
  const ok = call("Key {{TOOL_ERP}}", "https://api.erp.com/stock");
  assert.deepEqual(ok, { ok: true, headers: { Authorization: "Key erp-SECRETO" }, hasSecret: true });
  assert.equal(call("{{TOOL_ERP}}", "https://BACKUP.erp.com/stock").ok, true);
  assert.equal(call("{{TOOL_ERP}}", "https://atacante.com/stock").ok, false);
  assert.equal(call("{{TOOL_ERP}}", "https://erp.com/stock").ok, false);
  // la declaración de hosts no es un secreto resoluble
  assert.equal(call("{{TOOL_ERP_HOSTS}}", "https://api.erp.com/stock").ok, false);
});

test("KOMMO_API_DOMAIN y KOMMO_SUBDOMAIN son DATOS: se resuelven sin atar a un host", () => {
  const r = call("{{KOMMO_API_DOMAIN}}|{{KOMMO_SUBDOMAIN}}", "https://cualquiera.com/x");
  assert.deepEqual(r, { ok: true, headers: { Authorization: "cliente.kommo.com|cliente" }, hasSecret: false });
});

test("sin KOMMO_API_DOMAIN configurado el token no se resuelve hacia ningún host", () => {
  const r = resolveToolHeaders({
    headers: [{ name: "A", value: "{{KOMMO_ACCESS_TOKEN}}" }],
    urlTemplate: "https://cliente.kommo.com/x",
    finalUrl: "https://cliente.kommo.com/x",
    lookup: (k) => (k === "KOMMO_ACCESS_TOKEN" ? "t" : undefined),
  });
  assert.equal(r.ok, false);
});

test("headers sin placeholders pasan tal cual y no cuentan como secreto", () => {
  const r = resolveToolHeaders({ headers: [{ name: "Accept", value: "application/json" }], urlTemplate: "https://a.com", finalUrl: "https://a.com", lookup });
  assert.deepEqual(r, { ok: true, headers: { Accept: "application/json" }, hasSecret: false });
});

test("normalizeHost / claves", () => {
  assert.equal(normalizeHost("https://Cliente.Kommo.com/api"), "cliente.kommo.com");
  assert.equal(normalizeHost("cliente.kommo.com:443"), "cliente.kommo.com");
  assert.equal(normalizeHost(""), null);
  assert.equal(normalizeHost("a b"), null);
  assert.equal(isCustomSecretKey("TOOL_ERP"), true);
  assert.equal(isCustomSecretKey("TOOL_ERP_HOSTS"), false);
  assert.equal(isToolConfigKey("TOOL_ERP_HOSTS"), true);
  assert.equal(isToolConfigKey("SUPABASE_SERVICE_ROLE_KEY"), false);
  assert.equal(isToolConfigKey("ANTHROPIC_API_KEY"), false);
});

test("paridad: la copia de las Edge Functions es idéntica a la de la web", () => {
  const body = (s: string) => s.slice(s.indexOf("export const HTTP_TOOL_DATA_KEYS = [")).replace(/\s+/g, " ").trim();
  const web = readFileSync(here("./http-tool-keys.ts"), "utf8");
  const edge = readFileSync(here("../../../supabase/functions/_shared/http-tool-keys.ts"), "utf8");
  assert.equal(body(edge), body(web));
});

test("guardia: el probador y el runtime resuelven con atado a hosts, sin process.env, con redirect manual y alcance configuracion", () => {
  const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const route = readFileSync(here("../app/api/tools/test/route.ts"), "utf8");
  assert.ok(!/process\.env/.test(sinComentarios(route)), "tools/test no puede leer process.env");
  assert.ok(/resolveToolHeaders\(/.test(route), "tools/test debe resolver headers atando secretos a hosts");
  assert.ok(/redirect: "manual"/.test(route), "tools/test: redirect manual con secretos");
  assert.ok(/requireScope\("configuracion"\)/.test(route), "tools/test exige alcance configuracion");
  const gen = readFileSync(here("../../../supabase/functions/generate-response/index.ts"), "utf8");
  assert.ok(/resolveToolHeaders\(/.test(gen), "generate-response resuelve headers atando secretos a hosts");
  assert.ok(/redirect: "manual"/.test(gen), "generate-response: redirect manual con secretos");
  assert.ok(!/h\.value\.replace\(\/\\\{\\\{/.test(gen), "generate-response no debe sustituir {{K}} de headers a mano");
});
