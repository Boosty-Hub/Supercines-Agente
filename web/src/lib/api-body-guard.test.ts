// GUARDIA de código: ninguna ruta lee el body a mano. Todo `route.ts` bajo `src/app` pasa por
// `readJson`/`readForm` (lib/api/body.ts), que convierten un body inválido en 400/413 claro.
// Antes, `await request.json()` sin atrapar daba 500 ante JSON roto, cuerpo vacío o un JSON
// mandado a una ruta de formulario.
//
// Análisis con el AST de TypeScript (no regex): en cada función se toman los parámetros tipados
// `Request`/`NextRequest` y se marca cualquier acceso `.json/.formData/.text/.arrayBuffer/.blob/
// .body` sobre ellos (también vía `.clone()`, alias `const r = request` o desestructuración).
// `res.json()` de un fetch NO es el request y no se marca.
// Correr con: cd web && node --test src/lib/api-body-guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const FORBIDDEN = new Set(["json", "formData", "text", "arrayBuffer", "blob", "body", "bytes"]);
const REQUEST_TYPES = new Set(["Request", "NextRequest"]);

type Finding = { line: number; access: string };

function findRawBodyReads(fileName: string, source: string): Finding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Finding[] = [];

  const isRequestParam = (p: ts.ParameterDeclaration) =>
    !!p.type &&
    ts.isTypeReferenceNode(p.type) &&
    ts.isIdentifier(p.type.typeName) &&
    REQUEST_TYPES.has(p.type.typeName.text);

  // Nombres que apuntan al request dentro de un cuerpo de función (parámetro + alias).
  const scanFunction = (fn: ts.SignatureDeclaration & { body?: ts.Node }) => {
    const names = new Set<string>();
    for (const p of fn.parameters) if (isRequestParam(p) && ts.isIdentifier(p.name)) names.add(p.name.text);
    if (names.size === 0 || !fn.body) return;

    // `request` o `request.clone()` (encadenable) o `(request as X)`.
    const refersToRequest = (e: ts.Expression): boolean => {
      while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
      if (ts.isIdentifier(e)) return names.has(e.text);
      if (
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.name.text === "clone"
      ) {
        return refersToRequest(e.expression.expression);
      }
      return false;
    };

    const report = (node: ts.Node, access: string) =>
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, access });

    const visit = (node: ts.Node) => {
      // Alias: const r = request;
      if (ts.isVariableDeclaration(node) && node.initializer && refersToRequest(node.initializer)) {
        if (ts.isIdentifier(node.name)) names.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const key = el.propertyName ?? el.name;
            if (ts.isIdentifier(key) && FORBIDDEN.has(key.text)) report(el, `{ ${key.text} } = request`);
          }
        }
      }
      if (ts.isPropertyAccessExpression(node) && FORBIDDEN.has(node.name.text) && refersToRequest(node.expression)) {
        report(node, node.getText(sf));
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        FORBIDDEN.has(node.argumentExpression.text) &&
        refersToRequest(node.expression)
      ) {
        report(node, node.getText(sf));
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
  };

  const walkAll = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      scanFunction(node);
    }
    ts.forEachChild(node, walkAll);
  };
  walkAll(sf);
  return out;
}

const APP = fileURLToPath(new URL("../app", import.meta.url));

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, acc);
    else if (name === "route.ts") acc.push(p);
  }
  return acc;
}

test("auto-prueba: el detector marca las lecturas a mano del request", () => {
  const src = `
    import { NextRequest } from "next/server";
    export async function POST(request: Request) { const b = await request.json(); }
    export async function PUT(req: NextRequest) { const f = await req.formData(); }
    export async function PATCH(request: Request) { const t = await request.clone().text(); }
    export const DELETE = async (r: Request) => { const s = r.body?.getReader(); };
    export async function GET(request: Request) { const a = request; await a.arrayBuffer(); }
    export async function HEAD(request: Request) { const { json } = request; }
    export async function OPTIONS(request: Request) { await (request as Request)["blob"](); }
  `;
  const found = findRawBodyReads("synthetic/route.ts", src).map((f) => f.access);
  assert.deepEqual(found, [
    "request.json",
    "req.formData",
    "request.clone().text",
    "r.body",
    "a.arrayBuffer",
    "{ json } = request",
    '(request as Request)["blob"]',
  ]);
});

test("auto-prueba: el detector NO marca respuestas de fetch, archivos ni el helper", () => {
  const src = `
    import { readJson } from "@/lib/api/body";
    export async function POST(request: Request) {
      const parsed = await readJson(request, schema);
      const res = await fetch("https://x");
      const data = await res.json();
      const t = await res.text();
      const file = new File(["x"], "a"); await file.text(); await file.arrayBuffer();
      const url = new URL(request.url); request.headers.get("x");
    }
    export async function GET() { const r = await fetch("y"); await r.json(); }
  `;
  assert.deepEqual(findRawBodyReads("synthetic/route.ts", src), []);
});

// Autorización ANTES de leer el body: un anónimo recibe 401/403, nunca un 400 que le describa la
// forma esperada. Por función: la primera llamada de auth tiene que preceder a readJson/readForm.
const AUTH_CALLS = /requireScope\(|auth\.getUser\(\)|authorizeProvision\(/;
// Única ruta que lee el body sin sesión, por diseño: crea el PRIMER usuario (/first-run) y la
// protege el candado «ya existe un usuario → 409» (INVARIANT del archivo).
const PUBLIC_BODY_ROUTES = new Set(["api/provision/register/route.ts"]);

function bodyReadsBeforeAuth(fileName: string, source: string): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^read(Json|Form)$/.test(node.expression.text)) {
      let fn: ts.Node | undefined = node.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      const fnStart = fn ? fn.getStart(sf) : 0;
      const before = source.slice(fnStart, node.getStart(sf));
      if (!AUTH_CALLS.test(before)) out.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

test("auto-prueba: detecta un readJson antes de la autorización", () => {
  const bad = `export async function POST(request: Request) { const b = await readJson(request, S); const a = await requireScope("x"); }`;
  const good = `export async function POST(request: Request) { const a = await requireScope("x"); if (!a.ok) return a.response; const b = await readJson(request, S); }`;
  assert.deepEqual(bodyReadsBeforeAuth("x.ts", bad), [1]);
  assert.deepEqual(bodyReadsBeforeAuth("x.ts", good), []);
});

test("GUARDIA: toda ruta autoriza (401/403) antes de leer el body", () => {
  const offenders: string[] = [];
  for (const f of routeFiles(APP)) {
    const rel = relative(APP, f).split(sep).join("/");
    if (PUBLIC_BODY_ROUTES.has(rel)) continue;
    for (const line of bodyReadsBeforeAuth(f, readFileSync(f, "utf8"))) offenders.push(`${rel}:${line}`);
  }
  assert.deepEqual(offenders, [], `Leen el body antes de autorizar:\n${offenders.join("\n")}`);
});

test("GUARDIA: ningún route.ts lee el body del request fuera de lib/api/body.ts", () => {
  const files = routeFiles(APP);
  assert.ok(files.length > 50, `se esperaban >50 route.ts, hay ${files.length} (¿cambió la ruta?)`);
  const offenders: string[] = [];
  for (const f of files) {
    for (const hit of findRawBodyReads(f, readFileSync(f, "utf8"))) {
      offenders.push(`${relative(APP, f).split(sep).join("/")}:${hit.line} → ${hit.access}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Rutas que leen el body a mano (usar readJson/readForm de @/lib/api/body):\n${offenders.join("\n")}`
  );
});
