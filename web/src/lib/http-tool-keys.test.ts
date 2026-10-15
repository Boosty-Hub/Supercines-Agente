// Secretos de http tools atados a sus hosts (anti-exfiltración) y sin «parser differential».
// Correr con: cd web && node --test src/lib/http-tool-keys.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isBindableHost,
  isCustomSecretKey,
  isToolConfigKey,
  normalizeHost,
  parseToolUrl,
  publicKeysForHeaders,
  resolveToolHeaders,
  secretKeysInHeaders,
} from "./http-tool-keys.ts";

import { isSecretConfigKey } from "./config-secrets.ts";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const CFG: Record<string, string> = {
  KOMMO_ACCESS_TOKEN: "kommo-SECRETO",
  KOMMO_API_DOMAIN: "cliente.kommo.com",
  KOMMO_SUBDOMAIN: "cliente",
  TOOL_ERP: "erp-SECRETO",
  TOOL_ERP_HOSTS: "api.erp.com, Backup.erp.com",
  TOOL_SIN_HOSTS: "x-SECRETO",
  TOOL_ALLOWED: "allowed-SECRETO",
  TOOL_ALLOWED_HOSTS: "allowed.com",
  SUPABASE_SERVICE_ROLE_KEY: "eyJSERVICE",
  ANTHROPIC_API_KEY: "sk-ant-SECRETO",
};
const lookup = (k: string) => (Object.hasOwn(CFG, k) ? CFG[k] : undefined);
const call = (headerValue: string, finalUrl: string, urlTemplate = finalUrl) =>
  resolveToolHeaders({ headers: [{ name: "Authorization", value: headerValue }], urlTemplate, finalUrl, lookup });

test("caso legítimo de Kommo: el token viaja al host EXACTO de KOMMO_API_DOMAIN", () => {
  const r = call("Bearer {{KOMMO_ACCESS_TOKEN}}", "https://cliente.kommo.com/api/v4/leads?x=1");
  assert.deepEqual(r, {
    ok: true,
    url: "https://cliente.kommo.com/api/v4/leads?x=1",
    headers: { Authorization: "Bearer kommo-SECRETO" },
    hasSecret: true,
  });
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
  const r443 = call("{{KOMMO_ACCESS_TOKEN}}", "https://cliente.kommo.com:443/x");
  assert.equal(r443.ok, true);
  assert.equal(r443.ok && r443.url, "https://cliente.kommo.com/x", "el fetch usa la href normalizada");
  assert.equal(call("{{KOMMO_ACCESS_TOKEN}}", "no es una url").ok, false);
});

// ── Diferenciales de parser: tabla de URLs de ataque conocidas ──────────────────────────
// El secreto TOOL_ALLOWED está atado a allowed.com. `true` = se acepta (y va a allowed.com).
const ATTACKS: ReadonlyArray<readonly [string, boolean]> = [
  ["https://allowed.com/", true],
  ["https://allowed.com/path?q=1#frag", true],
  ["https://ALLOWED.com", true], // mismo host en mayúsculas: el parser lo baja y coincide
  ["https://allowed.com:443/", true], // puerto default: href sin puerto
  ["https://allowed.com\\@evil.com/", false], // backslash: WHATWG lo lee como «/»
  ["https://allowed.com\\.evil.com/", false],
  ["https://evil.com%2F@allowed.com", false], // userinfo con / codificada
  ["https://evil.com%2f@allowed.com/", false],
  ["https://evil.com%5C@allowed.com/", false],
  ["https://allowed.com%2F.evil.com/", false], // % en el host
  ["https://allowed.com%00.evil.com", false], // %00 en el host
  ["https://allowed.com/x%00", false], // %00 en cualquier lado
  ["https://allowed.com\t.evil.com", false], // tab real (WHATWG lo borra en silencio)
  ["https://allowed.com\\t.evil.com", false], // «\t» literal
  ["https://allowed.com\n.evil.com", false],
  ["https://allowed.com\r\n/", false],
  ["https://allowed.com /", false],
  ["https://allowed.com /", false], // espacio Unicode
  ["https://allowed.com /", false],
  ["https://allowed.com﻿/", false],
  [" https://allowed.com/", false], // espacio inicial (WHATWG lo recorta)
  ["https://allowed.com./", false], // punto final: otro host para TLS/vhost
  ["https://allowed.com.:443", false],
  ["https://allowed.com..evil.com/", false],
  ["https://allowed.com@evil.com/", false],
  ["https://user@allowed.com/", false], // userinfo aun al host correcto
  ["https://allowed.com:8443/", false],
  ["https://allowed.com:0443/", false],
  ["https://allowed.com:/", false],
  ["https://2130706433/", false], // 127.0.0.1 en decimal
  ["https://0177.0.0.1/", false], // octal
  ["https://0x7f.1/", false], // hexadecimal abreviada
  ["https://127.1/", false], // abreviada
  ["https://127.0.0.1/", false],
  ["https://10.0.0.5/", false],
  ["https://[::1]/", false],
  ["https://[::ffff:127.0.0.1]/", false], // IPv4 mapeada
  ["https://localhost/", false],
  ["https://api.localhost/", false],
  ["https://allowed/", false], // una sola etiqueta
  ["https://xn--allwed-8xa.com/", false], // punycode que no es el host declarado
  ["https://allöwed.com/", false], // IDN sin codificar: no-ASCII
  ["https://аllowed.com/", false], // «а» cirílica (homógrafo)
  ["HTTPS://allowed.com/", false], // el esquema va literal en minúsculas
  ["https:allowed.com/", false],
  ["https:/allowed.com/", false],
  ["https:///allowed.com/", false],
  ["//allowed.com/", false],
  ["http://allowed.com/", false],
  ["https://evil.com/allowed.com", false],
  ["https://evil.com#@allowed.com", false],
  ["https://evil.com?@allowed.com", false],
  ["https://allowed.com.evil.com/", false],
];

test("diferenciales: tabla de URLs de ataque conocidas con su resultado esperado", () => {
  for (const [url, expected] of ATTACKS) {
    const r = call("Key {{TOOL_ALLOWED}}", url);
    assert.equal(r.ok, expected, JSON.stringify(url));
    if (r.ok) {
      assert.equal(new URL(r.url).hostname, "allowed.com", JSON.stringify(url));
    } else {
      assert.ok(!JSON.stringify(r).includes("SECRETO"), "el error no filtra el secreto");
    }
  }
});

test("diferenciales: sin secretos igual se rechaza lo ambiguo (el fetch siempre usa la href parseada)", () => {
  const sin = (u: string) =>
    resolveToolHeaders({ headers: [{ name: "Accept", value: "application/json" }], urlTemplate: u, finalUrl: u, lookup });
  for (const u of [
    "https://allowed.com\\@evil.com/",
    "https://allowed.com\t.evil.com",
    "https://a.com %20",
    "https://evil.com%2F@allowed.com",
    "https://u@a.com/",
    "https://127.1/", // el parser lo reescribe a 127.0.0.1: diferencial
    "https://0x7f.1/",
    "https://2130706433/",
    "http://a.com/",
  ]) {
    assert.equal(sin(u).ok, false, JSON.stringify(u));
  }
  const ok = sin("https://API.example.com:8443/x?y=%C3%B1");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.url, "https://api.example.com:8443/x?y=%C3%B1");
});

// PRNG determinístico (mulberry32): la propiedad se prueba sobre miles de URLs mutadas.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("propiedad: toda URL aceptada se usa como new URL(url).href y su hostname está en los hosts permitidos", () => {
  const pieces = [
    "allowed.com", "cliente.kommo.com", "evil.com", "ALLOWED.COM", ".", "..", "@", ":", ":443", ":8443", "/", "\\", "%2F", "%2f",
    "%5C", "%00", "%40", "#", "?", "\t", "\n", " ", " ", "0x7f", "127", "1", "[", "]", "::1", "xn--",
    "a", "-", "_", "localhost", "https://", "http://", "%", "ö", "。",
  ];
  const next = rng(1729);
  const pick = () => pieces[Math.floor(next() * pieces.length)];
  let accepted = 0;
  for (let i = 0; i < 20000; i++) {
    let s = "https://";
    const n = 1 + Math.floor(next() * 6);
    for (let j = 0; j < n; j++) s += pick();
    if (next() < 0.5) s += "/" + pick() + pick();
    for (const header of ["Key {{TOOL_ALLOWED}}", "Bearer {{KOMMO_ACCESS_TOKEN}}"]) {
      const r = call(header, s);
      if (!r.ok) continue;
      accepted++;
      const parsed = new URL(r.url);
      assert.equal(parsed.href, r.url, JSON.stringify(s));
      const allowed = header.includes("TOOL_ALLOWED") ? ["allowed.com"] : ["cliente.kommo.com"];
      assert.ok(allowed.includes(parsed.hostname), `${JSON.stringify(s)} → ${parsed.hostname}`);
      assert.equal(parsed.protocol, "https:");
      assert.equal(parsed.port, "");
      assert.equal(parsed.username + parsed.password, "");
    }
  }
  assert.ok(accepted > 0, "la generación produce también casos legítimos");
});

test("parseToolUrl / isBindableHost", () => {
  assert.equal(parseToolUrl("https://a.com/x", { strict: true }).ok, true);
  assert.equal(parseToolUrl("https://1.2.3.4/x", { strict: false }).ok, true);
  assert.equal(parseToolUrl("https://1.2.3.4/x", { strict: true }).ok, false);
  assert.equal(parseToolUrl("https://a.com:8443/x", { strict: false }).ok, true);
  assert.equal(parseToolUrl("https://a.com:8443/x", { strict: true }).ok, false);
  for (const h of ["a.com", "api.erp.com", "xn--bcher-kva.example"]) assert.equal(isBindableHost(h), true, h);
  for (const h of ["localhost", "a.localhost", "1.2.3.4", "127.1", "0x7f.1", "2130706433", "a.com.", "a..com", "-a.com", "a", "A.com", ""]) {
    assert.equal(isBindableHost(h), false, h);
  }
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
  assert.deepEqual(ok, { ok: true, url: "https://api.erp.com/stock", headers: { Authorization: "Key erp-SECRETO" }, hasSecret: true });
  assert.equal(call("{{TOOL_ERP}}", "https://BACKUP.erp.com/stock").ok, true);
  assert.equal(call("{{TOOL_ERP}}", "https://atacante.com/stock").ok, false);
  assert.equal(call("{{TOOL_ERP}}", "https://erp.com/stock").ok, false);
  // la declaración de hosts no es un secreto resoluble
  assert.equal(call("{{TOOL_ERP_HOSTS}}", "https://api.erp.com/stock").ok, false);
});

test("TOOL_<X>_HOSTS con IPs o localhost no ata nada", () => {
  const r = resolveToolHeaders({
    headers: [{ name: "A", value: "{{TOOL_IP}}" }],
    urlTemplate: "https://127.0.0.1/x",
    finalUrl: "https://127.0.0.1/x",
    lookup: (k) => ({ TOOL_IP: "s", TOOL_IP_HOSTS: "127.0.0.1, localhost, 2130706433" } as Record<string, string>)[k],
  });
  assert.equal(r.ok, false);
});

test("KOMMO_API_DOMAIN y KOMMO_SUBDOMAIN son DATOS: se resuelven sin atar a un host", () => {
  const r = call("{{KOMMO_API_DOMAIN}}|{{KOMMO_SUBDOMAIN}}", "https://cualquiera.com/x");
  assert.deepEqual(r, { ok: true, url: "https://cualquiera.com/x", headers: { Authorization: "cliente.kommo.com|cliente" }, hasSecret: false });
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

test("un secreto sin valor RECHAZA (nunca «Bearer » vacío) con el mensaje del llamador", () => {
  const base = {
    headers: [{ name: "A", value: "Bearer {{KOMMO_ACCESS_TOKEN}}" }],
    urlTemplate: "https://cliente.kommo.com/x",
    finalUrl: "https://cliente.kommo.com/x",
    lookup: (k: string) => (k === "KOMMO_API_DOMAIN" ? "cliente.kommo.com" : undefined),
  };
  const r = resolveToolHeaders(base);
  assert.deepEqual(r, { ok: false, error: "el secreto {{KOMMO_ACCESS_TOKEN}} no está configurado" });
  const r2 = resolveToolHeaders({ ...base, missingSecret: (k) => `pegá el valor de prueba de {{${k}}}` });
  assert.deepEqual(r2, { ok: false, error: "pegá el valor de prueba de {{KOMMO_ACCESS_TOKEN}}" });
});

test("headers sin placeholders pasan tal cual y no cuentan como secreto", () => {
  const r = resolveToolHeaders({ headers: [{ name: "Accept", value: "application/json" }], urlTemplate: "https://a.com", finalUrl: "https://a.com", lookup });
  assert.deepEqual(r, { ok: true, url: "https://a.com/", headers: { Accept: "application/json" }, hasSecret: false });
});

test("secretKeysInHeaders / publicKeysForHeaders", () => {
  const headers = [
    { name: "Authorization", value: "Bearer {{KOMMO_ACCESS_TOKEN}}" },
    { name: "X-Erp", value: "{{TOOL_ERP}} {{TOOL_ERP}}" },
    { name: "X-Sub", value: "{{KOMMO_SUBDOMAIN}}" },
    { name: "X-Raro", value: "{{ANTHROPIC_API_KEY}}" },
  ];
  assert.deepEqual(secretKeysInHeaders(headers), ["KOMMO_ACCESS_TOKEN", "TOOL_ERP"]);
  assert.deepEqual(publicKeysForHeaders(headers).sort(), ["KOMMO_API_DOMAIN", "KOMMO_SUBDOMAIN", "TOOL_ERP_HOSTS"]);
});

test("normalizeHost / claves", () => {
  assert.equal(normalizeHost("https://Cliente.Kommo.com/api"), "cliente.kommo.com");
  assert.equal(normalizeHost("cliente.kommo.com:443"), "cliente.kommo.com");
  assert.equal(normalizeHost(""), null);
  assert.equal(normalizeHost("a b"), null);
  assert.equal(normalizeHost("127.0.0.1"), null);
  assert.equal(normalizeHost("localhost"), null);
  assert.equal(normalizeHost("http://a.com"), null, "solo https");
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

const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("guardia: el probador y el runtime resuelven con atado a hosts, sin process.env, con redirect manual y alcance configuracion", () => {
  const route = readFileSync(here("../app/api/tools/test/route.ts"), "utf8");
  assert.ok(!/process\.env/.test(sinComentarios(route)), "tools/test no puede leer process.env");
  assert.ok(/resolveToolHeaders\(/.test(route), "tools/test debe resolver headers atando secretos a hosts");
  assert.ok(/redirect: "manual"/.test(route), "tools/test: redirect manual con secretos");
  assert.ok(/requireScope\("configuracion"\)/.test(route), "tools/test exige alcance configuracion");
  const gen = readFileSync(here("../../../supabase/functions/generate-response/index.ts"), "utf8");
  assert.ok(/resolveToolHeaders\(/.test(gen), "generate-response resuelve headers atando secretos a hosts");
  assert.ok(/redirect: "manual"/.test(gen), "generate-response: redirect manual con secretos");
  assert.ok(!/h\.value\.replace\(\/\\\{\\\{/.test(gen), "generate-response no debe sustituir {{K}} de headers a mano");
  assert.ok(/lookup: \(k\) => cfg\.getDbOnly\(k\)/.test(gen), "generate-response resuelve {{K}} SOLO desde runtime_config (getDbOnly)");
  assert.ok(!/lookup: \(k\) => cfg\.get\(k\)/.test(gen), "generate-response no cae a Deno.env para {{K}}");
});

test("guardia: el probador NO lee secretos de runtime_config (solo claves públicas + valores tecleados)", () => {
  const route = sinComentarios(readFileSync(here("../app/api/tools/test/route.ts"), "utf8"));
  // Ningún lector que pueda traer secretos: ni el mapa completo ni lecturas por clave con fallback.
  for (const fn of ["getRuntimeConfig", "configValue", "configValues", "configValuesFresh", "createServiceClient", "loadConfig"]) {
    assert.ok(!new RegExp(`\\b${fn}\\b`).test(route), `tools/test no puede usar ${fn}`);
  }
  assert.ok(!/\.from\(\s*["']runtime_config["']/.test(route), "tools/test no consulta runtime_config directo");
  assert.ok(!/\.from\(\s*["']kommo_credentials["']/.test(route), "tools/test no lee kommo_credentials");
  // La única lectura de config es la de claves públicas, con las claves que los headers necesitan.
  assert.ok(/publicConfigValues\(publicKeysForHeaders\(tool\.headers\)\)/.test(route), "tools/test lee solo publicConfigValues(publicKeysForHeaders(...))");
  // Los secretos salen SOLO de lo tecleado en el probador.
  assert.ok(/isToolSecretKey\(k\)\s*\?\s*Object\.hasOwn\(testSecrets, k\)/.test(route), "los secretos se resuelven solo desde testSecrets");
  assert.ok(/missingSecret:/.test(route), "sin valor tecleado, mensaje claro");
  // Los valores de prueba no se persisten ni se loguean.
  assert.ok(!/console\./.test(route), "tools/test no loguea nada");
  assert.ok(!/\.(insert|upsert|update)\(/.test(route), "tools/test no escribe en la base");
  assert.ok(!/setConfigValues/.test(route), "tools/test no persiste config");
});

test("guardia: la UI del probador pide los secretos de prueba sin guardarlos", () => {
  const ui = sinComentarios(readFileSync(here("../app/(dashboard)/settings/herramientas/tool-editor.tsx"), "utf8"));
  assert.ok(/secretKeysInHeaders\(/.test(ui), "el panel deriva los secretos que pide de los headers");
  assert.ok(/testSecrets/.test(ui), "el panel manda testSecrets a /api/tools/test");
  assert.ok(/type="password"/.test(ui), "los valores de prueba van en inputs password");
  assert.ok(!/localStorage|sessionStorage/.test(ui), "los valores de prueba no se guardan en el navegador");
});

test("publicConfigValues rechaza claves secretas (el probador no puede traer un secreto ni por error)", () => {
  const src = readFileSync(here("./runtime-config.ts"), "utf8");
  const fn = src.slice(src.indexOf("export async function publicConfigValues"));
  assert.ok(/isSecretConfigKey\(k\)/.test(fn.slice(0, 600)) && /throw new Error/.test(fn.slice(0, 600)), "lanza ante una clave secreta");
  assert.ok(/\.in\("key"/.test(fn.slice(0, 1200)), "consulta solo las filas pedidas");
  // Y lo que el probador le pide es siempre público según la clasificación única.
  const keys = publicKeysForHeaders([
    { name: "A", value: "{{KOMMO_ACCESS_TOKEN}} {{KOMMO_API_DOMAIN}} {{KOMMO_SUBDOMAIN}} {{TOOL_ERP}} {{TOOL_Z_9}}" },
  ]);
  assert.ok(keys.length > 0);
  for (const k of keys) assert.equal(isSecretConfigKey(k), false, k);
});

test("guardia: el fetch de la tool usa la URL VALIDADA (resolved.url), nunca la cadena interpolada", () => {
  const route = sinComentarios(readFileSync(here("../app/api/tools/test/route.ts"), "utf8"));
  const gen = sinComentarios(readFileSync(here("../../../supabase/functions/generate-response/index.ts"), "utf8"));
  for (const [name, src] of [["tools/test", route], ["generate-response", gen]] as const) {
    assert.ok(/const url = resolved\.url;/.test(src), `${name}: url = resolved.url`);
    assert.ok(/await fetch\(url, \{/.test(src), `${name}: fetch(url, …) con la URL validada`);
    assert.ok(!/fetch\(interpolatedUrl/.test(src), `${name}: nunca fetch de la cadena original`);
  }
});
