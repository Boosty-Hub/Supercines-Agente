// PARIDAD de la salida de texto hacia Kommo, por FUNCIÓN y por LLAMADA (AST de TypeScript),
// sobre supabase/functions/** Y web/src/**. Reemplaza al análisis por regex sobre el archivo
// entero: «el archivo menciona writeClientText en alguna parte» no prueba que la función que
// dispara el salesbot haya verificado el texto antes.
//
// Reglas (cada una explica qué rompería):
//  R1. patchLeadField / patchContactField solo se llaman desde _shared/outbound.ts (que
//      verifica el texto) — y se definen en _shared/kommo.ts. Cualquier otro llamador
//      escribiría texto al cliente/CRM sin el verificador.
//  R2. Cada FUNCIÓN que llama a runSalesbot (el disparo que hace SALIR el texto) llama,
//      en esa misma función, a writeClientText (verifica y escribe el campo).
//  R3. Ningún fetch MUTANTE (POST/PATCH/PUT/DELETE) a la API de Kommo (`/api/v4/`) fuera de
//      los módulos de integración permitidos, y ninguna construcción de `custom_fields_values`
//      fuera de _shared/kommo.ts: son las otras dos formas de escribir texto saltándose a outbound.ts.
//  R4. La web nunca importa los sinks de texto de las Edge Functions (no comparten código).
// Correr con: cd web && node --test src/lib/outbound-parity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ROOTS = [join(REPO, "supabase", "functions"), join(REPO, "web", "src")];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== ".next") walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.includes(".generated.")) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p: string) => relative(REPO, p).split(sep).join("/");
const parse = (p: string) =>
  ts.createSourceFile(p, readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true, p.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const calleeName = (c: ts.CallExpression): string | null =>
  ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : null;

/** Función contenedora más externa dentro del archivo (el límite de «misma función»). */
function outermostFunction(n: ts.Node): ts.Node | null {
  let found: ts.Node | null = null;
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) || ts.isMethodDeclaration(p)) found = p;
  }
  return found;
}

function calls(root: ts.Node, names: ReadonlySet<string>): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && names.has(name)) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r));

test("R1: patchLeadField/patchContactField solo se llaman desde _shared/outbound.ts", () => {
  const bad: string[] = [];
  for (const f of FILES) {
    const r = rel(f);
    if (r === "supabase/functions/_shared/outbound.ts") continue;
    for (const c of calls(parse(f), new Set(["patchLeadField", "patchContactField"]))) {
      bad.push(`${r}: ${calleeName(c)} (usar writeClientText o writeCrmField de _shared/outbound.ts)`);
    }
  }
  assert.deepEqual(bad, []);
});

test("R2: cada función que dispara runSalesbot llama a writeClientText en esa misma función", () => {
  const bad: string[] = [];
  let seen = 0;
  for (const f of FILES) {
    const r = rel(f);
    if (r === "supabase/functions/_shared/kommo.ts") continue; // la definición
    const sf = parse(f);
    for (const c of calls(sf, new Set(["runSalesbot"]))) {
      seen++;
      const fn = outermostFunction(c);
      const verifies = fn ? calls(fn, new Set(["writeClientText"])).length > 0 : false;
      if (!verifies) {
        const line = sf.getLineAndCharacterOfPosition(c.getStart()).line + 1;
        bad.push(`${r}:${line}: runSalesbot sin writeClientText en la misma función`);
      }
    }
  }
  assert.ok(seen >= 2, "no se encontró ningún runSalesbot: el análisis dejó de ver los sinks");
  assert.deepEqual(bad, []);
});

// Módulos de integración que SÍ hacen escrituras a la API de Kommo que no son texto al cliente
// (mover etapa, crear campos, registrar webhooks, credenciales): permitidos con su motivo.
const MUTATING_KOMMO_ALLOWED = new Set([
  "supabase/functions/_shared/kommo.ts", // cliente de la API de Kommo (PATCH de campos vía outbound.ts, etapa, salesbot)
  "web/src/lib/kommo.ts", // mover etapa, crear campos custom
  "web/src/app/api/kommo/webhook-auth/route.ts", // registrar/dar de baja el webhook
  "web/src/app/api/kommo/reconnect-webhook/route.ts", // re-suscribir el webhook
]);

function isMutatingKommoFetch(c: ts.CallExpression): boolean {
  if (!(ts.isIdentifier(c.expression) && c.expression.text === "fetch")) return false;
  const [url, init] = c.arguments;
  if (!url || !init || !ts.isObjectLiteralExpression(init)) return false;
  if (!url.getText().includes("/api/v4/")) return false;
  const method = init.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "method",
  );
  return Boolean(method && /["'`](POST|PATCH|PUT|DELETE)["'`]/i.test(method.initializer.getText()));
}

test("R3: ningún fetch mutante a /api/v4/ de Kommo ni custom_fields_values fuera de los módulos permitidos", () => {
  const bad: string[] = [];
  let kommoWrites = 0;
  for (const f of FILES) {
    const r = rel(f);
    const sf = parse(f);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && isMutatingKommoFetch(n)) {
        kommoWrites++;
        if (!MUTATING_KOMMO_ALLOWED.has(r)) {
          bad.push(`${r}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: fetch mutante a Kommo fuera de los módulos permitidos`);
        }
      }
      if (ts.isPropertyAssignment(n) && n.name.getText() === "custom_fields_values" && r !== "supabase/functions/_shared/kommo.ts") {
        bad.push(`${r}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: arma custom_fields_values fuera de _shared/kommo.ts`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.ok(kommoWrites >= 1, "no se encontró ningún fetch mutante a Kommo: el análisis dejó de ver los sinks");
  assert.deepEqual(bad, []);
});

test("R4: la web no importa los sinks de texto de las Edge Functions", () => {
  const bad: string[] = [];
  for (const f of FILES.filter((x) => rel(x).startsWith("web/src/"))) {
    const text = readFileSync(f, "utf8");
    if (/from\s+["'][^"']*supabase\/functions\/_shared\/(outbound|kommo)\.ts["']/.test(text)) bad.push(rel(f));
  }
  assert.deepEqual(bad, []);
});

test("la guardia se prueba a sí misma: detecta un runSalesbot sin writeClientText y acepta el correcto", () => {
  const mk = (code: string) => ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);
  const analyze = (code: string) => {
    const sf = mk(code);
    return calls(sf, new Set(["runSalesbot"])).filter((c) => {
      const fn = outermostFunction(c);
      return !(fn && calls(fn, new Set(["writeClientText"])).length > 0);
    }).length;
  };
  assert.equal(analyze("async function a(){ await runSalesbot(1,2); }"), 1);
  // mencionar writeClientText en OTRA función del archivo no cuenta
  assert.equal(analyze("async function a(){ await runSalesbot(1,2); } async function b(){ await writeClientText({}); }"), 1);
  assert.equal(analyze("async function a(){ await writeClientText({}); await runSalesbot(1,2); }"), 0);
});
