// Test DINÁMICO de TODAS las rutas que leen body: se importa cada `app/api/**/route.ts` de verdad
// y se llama a sus handlers POST/PUT/PATCH/DELETE con bodies inválidos. Antes de la migración a
// lib/api/body.ts varios daban 500 (SyntaxError/TypeError sin atrapar); ahora todos dan 400/413.
// También comprueba que sin sesión la respuesta es 401 aunque el body esté roto (la autorización
// va primero).
//
// Cómo se cargan las rutas sin Next: `module.registerHooks` (in-thread) resuelve el alias `@/` y
// los imports sin extensión a los .ts de src/, y reemplaza por stubs lo que necesita el runtime de
// Next o la red: next/server (NextResponse sobre Response estándar), next/headers, next/navigation,
// server-only, la sesión (lib/auth/require-scope, lib/supabase/server), el cliente de servicio, el
// gate de provisión y los .generated.ts. La base y fetch son trampas: si una ruta los toca con un
// body inválido, el test falla (el body tenía que rechazarse antes).
// Correr con: cd web && node --test src/lib/api-body-routes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { MAX_BODY_BYTES, MAX_UPLOAD_BODY_BYTES } from "./api/body.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const APP_API = join(SRC, "app", "api");

// ── Stubs ────────────────────────────────────────────────────────────────────────────────────
const TRAP = `
const trap = (what) => new Proxy(function () {}, {
  get(_t, k) {
    if (k === "then") return undefined;
    throw new Error("TRAMPA: " + what + "." + String(k) + " — el body inválido debía rechazarse antes");
  },
  apply() { throw new Error("TRAMPA: " + what + "() — el body inválido debía rechazarse antes"); },
});
const user = () => (globalThis.__bodyTestAuth === "deny" ? null : { id: "00000000-0000-0000-0000-0000000000aa", email: "t@test", app_metadata: { role: "configuracion" } });
const sessionClient = () => {
  const db = trap("supabase");
  return new Proxy({}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "auth") return { getUser: async () => ({ data: { user: user() }, error: null }) };
      return db[k];
    },
  });
};
`;
const STUBS: Record<string, string> = {
  "next/server": `
export class NextResponse extends Response {
  static json(body, init) { return Response.json(body, init); }
  static redirect(url, init) { return Response.redirect(url, typeof init === "number" ? init : (init && init.status) || 307); }
  static next() { return new Response(null); }
}
export class NextRequest extends Request {}
`,
  "next/headers": `export async function cookies() { return { getAll: () => [], get: () => undefined, set() {} }; }
export async function headers() { return new Headers(); }`,
  "next/navigation": `export function redirect(u) { throw new Error("redirect " + u); } export function notFound() { throw new Error("notFound"); }`,
  "server-only": `export {};`,
  "@/lib/supabase/server": `${TRAP}
export async function createSupabaseServerClient() { return sessionClient(); }`,
  "@/lib/supabase/service": `${TRAP}
export function createServiceClient() { return trap("serviceClient"); }`,
  "@/lib/auth/require-scope": `${TRAP}
export async function requireScope(scope) {
  const u = user();
  if (!u) return { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
  return { ok: true, supabase: sessionClient(), user: u, scope, writer: { by: u.id, scope } };
}
export async function requirePageScope(scope) { return requireScope(scope); }`,
  "@/lib/provision/gate": `
export async function authorizeProvision() {
  if (globalThis.__bodyTestAuth === "deny") return { ok: false, response: Response.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  return { ok: true, mode: "session" };
}
export async function authorizeProvisionSession() { return authorizeProvision(); }
export async function rolesMigrationApplied() { return true; }`,
  "@/lib/provision/migrations.generated": `export const MIGRATIONS = [];`,
  "@/lib/provision/functions.generated": `export const FUNCTIONS = [];`,
};

// module.registerHooks existe desde Node 22.15 (engines: >=22.18); @types/node 20 no lo declara.
type Resolved = { url: string; shortCircuit?: boolean };
type Loaded = { format: string; source: string; shortCircuit?: boolean };
type Hooks = {
  resolve: (
    specifier: string,
    context: { parentURL?: string },
    nextResolve: (specifier: string, context: { parentURL?: string }) => Resolved
  ) => Resolved;
  load: (url: string, context: unknown, nextLoad: (url: string, context: unknown) => Loaded) => Loaded;
};
const { registerHooks } = nodeModule as unknown as { registerHooks: (hooks: Hooks) => void };

const CANDIDATES = (p: string) => [`${p}.ts`, `${p}.tsx`, join(p, "index.ts"), p];
function resolveFile(base: string): string | null {
  for (const c of CANDIDATES(base)) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(STUBS, specifier)) return { url: `stub:${specifier}`, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const file = resolveFile(join(SRC, specifier.slice(2)));
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    const parent = context.parentURL;
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      parent?.startsWith("file:") &&
      fileURLToPath(parent).startsWith(SRC) &&
      !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)
    ) {
      const file = resolveFile(fileURLToPath(new URL(specifier, parent)));
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    // Los .ts de src/ se transpilan con TypeScript (no strip-only: hay parameter properties,
    // p. ej. en lib/runtime-config.ts, que el type-stripping de Node no soporta).
    if (url.startsWith("file:") && /\.tsx?$/.test(url) && fileURLToPath(url).startsWith(SRC)) {
      const file = fileURLToPath(url);
      const out = ts.transpileModule(readFileSync(file, "utf8"), {
        fileName: file,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
          verbatimModuleSyntax: false,
        },
      });
      return { format: "module", source: out.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

// Entorno mínimo para que las rutas lleguen a leer el body (nada de esto se usa de verdad).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://stub-ref.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "stub-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "stub-service";
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`TRAMPA: fetch(${String(input)}) — el body inválido debía rechazarse antes`);
}) as typeof fetch;

// ── Descubrimiento de handlers que leen body ─────────────────────────────────────────────────
type Handler = { route: string; method: string; kind: "json" | "form"; maxBytes: number };

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, acc);
    else if (name === "route.ts") acc.push(p);
  }
  return acc;
}

const HANDLERS: (Handler & { file: string })[] = [];
for (const file of routeFiles(APP_API)) {
  const src = readFileSync(file, "utf8");
  const parts = src.split(/(?=^export (?:async )?function (?:POST|PUT|PATCH|DELETE)\b)/m);
  for (const part of parts) {
    const m = /^export (?:async )?function (POST|PUT|PATCH|DELETE)\b/.exec(part);
    if (!m) continue;
    const body = part.split(/^export /m).slice(0, 2).join("export ");
    const kind = /\breadForm\(/.test(body) ? "form" : /\breadJson\(/.test(body) ? "json" : null;
    if (!kind) continue;
    HANDLERS.push({
      file,
      route: relative(APP_API, file).split(sep).join("/").replace(/\/route\.ts$/, ""),
      method: m[1],
      kind,
      maxBytes: /MAX_UPLOAD_BODY_BYTES/.test(body) ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES,
    });
  }
}

const PUBLIC_BODY_ROUTES = new Set(["provision/register"]);
const PARAMS = { params: Promise.resolve({ id: "00000000-0000-0000-0000-0000000000bb" }) };

async function call(h: Handler & { file: string }, req: Request): Promise<Response> {
  const mod = (await import(pathToFileURL(h.file).href)) as Record<string, (r: Request, p: unknown) => Promise<Response>>;
  return mod[h.method](req, PARAMS);
}

const URL_ = (route: string) => `http://localhost/api/${route}`;
const req = (h: Handler, body: BodyInit | null, contentType: string | null) => {
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  return new Request(URL_(h.route), { method: h.method, body, headers });
};

type Case = { name: string; make: (h: Handler) => Request; status: number; code?: string };
const JSON_CASES: Case[] = [
  { name: "JSON roto", make: (h) => req(h, '{"x": ', "application/json"), status: 400, code: "invalid_body" },
  { name: "null", make: (h) => req(h, "null", "application/json"), status: 400 },
  { name: "string", make: (h) => req(h, '"hola"', "application/json"), status: 400 },
  { name: "formulario a ruta JSON", make: (h) => req(h, "a=1", "application/x-www-form-urlencoded"), status: 400, code: "invalid_body" },
  {
    name: "tamaño excesivo",
    make: (h) => req(h, `{"x":"${"a".repeat(h.maxBytes)}"}`, "application/json"),
    status: 413,
    code: "body_too_large",
  },
];
const FORM_CASES: Case[] = [
  { name: "JSON a ruta de formulario", make: (h) => req(h, '{"x":1}', "application/json"), status: 400, code: "invalid_body" },
  { name: "multipart roto", make: (h) => req(h, "--a\r\nbasura", "multipart/form-data; boundary=zzz"), status: 400, code: "invalid_body" },
  { name: "sin content-type", make: (h) => req(h, "a=1", null), status: 400, code: "invalid_body" },
  {
    name: "tamaño excesivo",
    make: (h) => req(h, new URLSearchParams({ x: "a".repeat(h.maxBytes) }), "application/x-www-form-urlencoded"),
    status: 413,
    code: "body_too_large",
  },
];

test("descubrimiento: todos los handlers que leen body (≥ 68)", () => {
  // SuperCines no tiene agent/publish, agent/shopify-actions, shopify/connect, settings/auto-update ni
  // provision/updates (el template suma 69) y agrega el ruteo (routing/config y routing/assignees).
  assert.ok(HANDLERS.length >= 68, `se esperaban ≥ 68 handlers con body, hay ${HANDLERS.length}`);
  assert.ok(HANDLERS.some((h) => h.route === "routing/config"));
  assert.ok(HANDLERS.some((h) => h.route === "routing/assignees"));
  assert.ok(HANDLERS.some((h) => h.route === "routing/assignees/[id]"));
  assert.ok(HANDLERS.some((h) => h.route === "settings/alerts" && h.kind === "form"));
  assert.ok(HANDLERS.some((h) => h.route === "settings/kommo" && h.kind === "form"));
  assert.ok(HANDLERS.some((h) => h.route === "agent" && h.kind === "form"));
});

for (const h of HANDLERS) {
  test(`${h.method} /api/${h.route}: body inválido → 400/413, nunca 500`, async () => {
    globalThis.__bodyTestAuth = "allow";
    for (const c of h.kind === "form" ? FORM_CASES : JSON_CASES) {
      const res = await call(h, c.make(h));
      const payload = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
      assert.equal(res.status, c.status, `${c.name}: status ${res.status} ${JSON.stringify(payload)}`);
      assert.equal(typeof payload?.error, "string", `${c.name}: falta un mensaje de error`);
      if (c.code) assert.equal(payload?.code, c.code, `${c.name}: code`);
    }
  });

  if (!PUBLIC_BODY_ROUTES.has(h.route)) {
    test(`${h.method} /api/${h.route}: sin sesión → 401 antes de mirar el body`, async () => {
      globalThis.__bodyTestAuth = "deny";
      try {
        const res = await call(h, req(h, '{"x": ', h.kind === "form" ? "multipart/form-data" : "application/json"));
        assert.equal(res.status, 401);
      } finally {
        globalThis.__bodyTestAuth = "allow";
      }
    });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __bodyTestAuth: "allow" | "deny" | undefined;
}
