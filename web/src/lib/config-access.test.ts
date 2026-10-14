// GUARDIA de código: runtime_config y los secretos solo se tocan desde el servidor, con el
// cliente de servicio, DESPUÉS de validar sesión + alcance (migración 0079: authenticated y anon
// ya no tienen privilegio sobre la tabla; esto impide que el panel vuelva a depender de eso).
// Correr con: cd web && node --test src/lib/config-access.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scopeRequeridoPara } from "./auth/roles.ts";
import { isSecretConfigKey } from "./config-secrets.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f) && !/\.generated\.ts$/.test(f)) out.push(p);
  }
  return out;
}

type SrcFile = { rel: string; src: string; imports: string[] };
const FILES: SrcFile[] = walk(SRC).map((p) => {
  const src = readFileSync(p, "utf8");
  // Solo imports de VALOR (un `import type` se borra al compilar y no trae código de servidor).
  // [^;] también cruza saltos de línea: cubre los imports multilínea.
  const imports = [...src.matchAll(/^import (?!type )[^;]*?from "@\/lib\/([^"]+)";/gm)].map((m) => m[1]);
  return { rel: relative(SRC, p).split(sep).join("/"), src, imports };
});
const byRel = new Map(FILES.map((f) => [f.rel, f]));

// Libs que leen config/secretos con service_role, directa o transitivamente.
const SERVER_LIBS = new Set(["runtime-config", "supabase/service"]);
for (let grew = true; grew; ) {
  grew = false;
  for (const f of FILES) {
    if (!f.rel.startsWith("lib/")) continue;
    const mod = f.rel.slice(4).replace(/\.(ts|tsx)$/, "");
    if (SERVER_LIBS.has(mod)) continue;
    if (f.imports.some((i) => SERVER_LIBS.has(i))) {
      SERVER_LIBS.add(mod);
      grew = true;
    }
  }
}

const isClient = (f: SrcFile) => /^\s*(?:\/\/[^\n]*\n|\s)*["']use client["']/.test(f.src);
const usesServerLib = (f: SrcFile) => f.imports.some((i) => SERVER_LIBS.has(i));
/** app/(dashboard)/settings/page.tsx → /settings ; app/api/x/[id]/route.ts → /api/x/[id] */
function urlOf(rel: string): string {
  return (
    "/" +
    rel
      .replace(/^app\//, "")
      .replace(/(^|\/)(page|route)\.tsx?$/, "")
      .split("/")
      .filter((seg) => seg && !/^\(.*\)$/.test(seg))
      .join("/")
  );
}

test("el set de libs de servidor se detecta (sanity)", () => {
  for (const m of ["runtime-config", "supabase/service", "setup-state", "sync-agent-tools", "kommo"]) {
    assert.ok(SERVER_LIBS.has(m), m);
  }
  assert.ok(!SERVER_LIBS.has("config-secrets"), "config-secrets debe seguir siendo puro");
  assert.ok(!SERVER_LIBS.has("setup-state-view"), "setup-state-view debe seguir siendo puro");
});

test('.from("runtime_config") SOLO en los módulos de servidor permitidos y SIEMPRE con service_role', () => {
  const PERMITIDOS = new Set([
    "lib/runtime-config.ts", // la vía del panel (createServiceClient)
    "lib/provision/config-token.ts", // /first-run: cliente inline con la service-role key
    "lib/provision/function-hashes.ts", // centro de updates: ídem
    "app/api/provision/status/route.ts", // ídem
  ]);
  const usan = FILES.filter((f) => /\.from\(\s*["'`]runtime_config["'`]\s*\)/.test(f.src)).map((f) => f.rel);
  assert.deepEqual(usan.filter((r) => !PERMITIDOS.has(r)), [], "lectura/escritura de runtime_config fuera de lib/runtime-config");
  for (const rel of PERMITIDOS) {
    const f = byRel.get(rel);
    assert.ok(f, `${rel} no existe (actualizar la lista)`);
    assert.doesNotMatch(f!.src, /createSupabaseServerClient|createBrowserClient|@\/lib\/supabase\/(server|client)"/, `${rel} usa el cliente de sesión`);
    assert.match(f!.src, /createServiceClient\(|createClient\([^)]*[sS]ervice[rR]ole/, `${rel} no usa service_role`);
  }
});

test("ningún componente cliente importa el cliente de servicio, runtime-config ni un lib que lea secretos", () => {
  const malos = FILES.filter(isClient).flatMap((f) =>
    f.imports.filter((i) => SERVER_LIBS.has(i)).map((i) => `${f.rel} → @/lib/${i}`)
  );
  assert.deepEqual(malos, []);
  const conTabla = FILES.filter(isClient).filter((f) => /\.from\(\s*["'`]runtime_config/.test(f.src)).map((f) => f.rel);
  assert.deepEqual(conTabla, []);
});

test("/first-run y /api/provision no importan runtime-config ni el cliente de servicio (invariante)", () => {
  const malos = FILES.filter((f) => /^app\/(first-run|api\/provision)\//.test(f.rel)).flatMap((f) =>
    f.imports.filter((i) => SERVER_LIBS.has(i)).map((i) => `${f.rel} → @/lib/${i}`)
  );
  assert.deepEqual(malos, []);
});

// El layout corre para TODO alcance (arma el shell): solo puede leer claves públicas.
const SIN_GUARDA: Record<string, string> = {
  "app/(dashboard)/layout.tsx":
    "shell de todo alcance: lee solo claves públicas (label, auto-update) y el estado del setup solo para configuracion",
};

test("toda ruta/página que use un lib de servidor valida sesión + alcance (requireScope/requirePageScope)", () => {
  const sinGuarda = FILES.filter((f) => f.rel.startsWith("app/") && usesServerLib(f))
    .filter((f) => !/requireScope\(|requirePageScope\(/.test(f.src))
    .map((f) => f.rel)
    .filter((r) => !(r in SIN_GUARDA));
  assert.deepEqual(sinGuarda, []);
});

test("el layout (sin guarda por alcance) solo lee claves PÚBLICAS de runtime_config", () => {
  const src = byRel.get("app/(dashboard)/layout.tsx")!.src;
  const keys = [...src.matchAll(/configValues?\(\s*\[?\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, "no se detectaron lecturas en el layout");
  for (const k of keys) assert.equal(isSecretConfigKey(k), false, `el layout lee ${k}, que es secreta`);
  assert.match(src, /scope === "configuracion"[^\n]*getSetupState\(\)/, "getSetupState solo para configuracion");
});

test("el alcance que exige cada ruta/página coincide con el de PATH_SCOPES (middleware)", () => {
  const mal: string[] = [];
  for (const f of FILES.filter((x) => x.rel.startsWith("app/"))) {
    for (const m of f.src.matchAll(/require(?:Page)?Scope\(\s*"(\w+)"\s*\)/g)) {
      const esperado = scopeRequeridoPara(urlOf(f.rel));
      if (esperado !== m[1]) mal.push(`${f.rel}: exige ${m[1]}, PATH_SCOPES dice ${esperado}`);
    }
  }
  assert.deepEqual(mal, []);
});

test("escribir runtime_config (setConfigValues/syncAgentTools/renameAgent) solo desde rutas con requireScope", () => {
  const mal = FILES.filter((f) => f.rel.startsWith("app/"))
    .filter((f) => /\b(setConfigValues|syncAgentTools|renameAgent)\(/.test(f.src))
    .filter((f) => !/requireScope\(/.test(f.src) || !/auth\.writer/.test(f.src))
    .map((f) => f.rel);
  assert.deepEqual(mal, []);
});

test("PATH_SCOPES cubre las rutas que tocan config y secretos con el alcance correcto", () => {
  const configuracion = [
    "/settings", "/agent", "/setup", "/config/kommo", "/tools", "/seguimiento",
    "/api/setup/credentials", "/api/setup/kommo", "/api/setup/agent", "/api/setup/memory",
    "/api/agent", "/api/agent/sync", "/api/agent/bcv", "/api/settings/alerts",
    "/api/usage/budget", "/api/usage/models", "/api/media-response",
    "/api/tools/test", "/api/kommo/webhook-auth", "/api/follow-up/config",
  ];
  for (const p of configuracion) assert.equal(scopeRequeridoPara(p), "configuracion", p);
  for (const p of ["/consumo", "/dreams", "/api/dreams/policy", "/api/dreams/frequency", "/api/usage/context"]) {
    assert.equal(scopeRequeridoPara(p), "contenido", p);
  }
  // Toda ruta/página del repo que use un lib de servidor tiene alcance declarado.
  for (const f of FILES.filter((x) => /^app\/.*\/(page|route)\.tsx?$/.test(x.rel) && usesServerLib(x))) {
    assert.notEqual(scopeRequeridoPara(urlOf(f.rel)), null, `${f.rel} sin alcance en PATH_SCOPES`);
  }
});
