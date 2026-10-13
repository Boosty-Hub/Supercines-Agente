// PARIDAD de la salida de texto hacia Kommo, por FUNCIÓN y por LLAMADA (AST de TypeScript),
// sobre supabase/functions/** Y web/src/**. Reemplaza al análisis por regex sobre el archivo
// entero: «el archivo menciona writeClientText en alguna parte» no prueba que la función que
// dispara el salesbot haya verificado el texto antes.
//
// Reglas (cada una explica qué rompería):
//  R1. patchLeadField / patchContactField solo se llaman desde _shared/outbound.ts (que
//      verifica el texto) — y se definen en _shared/kommo.ts. Cualquier otro llamador
//      escribiría texto al cliente/CRM sin el verificador.
//  R2. Cada llamada a runSalesbot (el disparo que hace SALIR el texto) va precedida, en la
//      misma función y por posición en el código, de un `await writeClientText(...)` (verifica y
//      escribe el campo) que además la FRENA: sin catch que trague el bloqueo, sin ramas que lo
//      salten (ver el detalle sobre whyWriteDoesNotGate).
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

// ─── R2: orden y bloqueo ───
//
// Para CADA llamada C a runSalesbot (el disparo que hace SALIR el texto), la llamada W a
// writeClientText que la precede (la más cercana por posición en el código) debe:
//   a) estar en la MISMA función (la más interna) que C, y ANTES de C en el código;
//   b) estar esperada (`await writeClientText(...)` o `return`): sin await el rechazo no frena a C,
//      y `.catch(...)`/`.then(...)` encadenados convierten el bloqueo en un no-op;
//   c) dominar a C: no estar en una rama (if/else, ?:, &&, ||, ??, case) que no contenga a C;
//   d) BLOQUEAR: si W está dentro de un try, o bien C está en ese mismo bloque try (la excepción salta a
//      C también), o bien el catch termina en return/throw (no sigue hacia C). Un catch que traga el
//      OutboundBlockedError y deja seguir hasta runSalesbot dejaría salir el texto sin verificar.
const FUNCTION_KINDS = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

function innermostFunction(n: ts.Node): ts.Node | null {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (FUNCTION_KINDS(p)) return p;
  return null;
}

const contains = (outer: ts.Node, inner: ts.Node) => inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd();

function endsInExit(block: ts.Block): boolean {
  const last = block.statements[block.statements.length - 1];
  return Boolean(last && (ts.isReturnStatement(last) || ts.isThrowStatement(last)));
}

/** Motivos por los que `w` NO frena de forma garantizada a `c` (vacío = sí lo frena). */
export function whyWriteDoesNotGate(w: ts.CallExpression, c: ts.CallExpression): string[] {
  const why: string[] = [];
  if (w.getStart() >= c.getStart()) why.push("writeClientText va DESPUÉS de runSalesbot");
  if (!(ts.isAwaitExpression(w.parent) || ts.isReturnStatement(w.parent))) why.push("writeClientText sin await (su rechazo no frena a runSalesbot)");
  const fn = innermostFunction(w);
  for (let prev: ts.Node = w, p: ts.Node | undefined = w.parent; p && p !== fn; prev = p, p = p.parent) {
    const branch =
      (ts.isIfStatement(p) && prev !== p.expression) ||
      (ts.isConditionalExpression(p) && prev !== p.condition) ||
      (ts.isBinaryExpression(p) && prev === p.right && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) ||
      ts.isCaseClause(p) ||
      ts.isDefaultClause(p);
    if (branch && !contains(prev, c)) why.push("writeClientText está en una rama que no domina a runSalesbot");
    if (ts.isTryStatement(p) && prev === p.tryBlock && !contains(p.tryBlock, c)) {
      if (!p.catchClause || !endsInExit(p.catchClause.block)) {
        why.push("writeClientText dentro de un try cuyo catch no termina en return/throw: el bloqueo se traga y runSalesbot sigue");
      }
    }
    if (ts.isCatchClause(p) || (ts.isTryStatement(p) && p.finallyBlock === prev)) {
      if (!contains(prev, c)) why.push("writeClientText en catch/finally que no domina a runSalesbot");
    }
  }
  return why;
}

/** Problemas de R2 en un archivo (cada runSalesbot contra su writeClientText más cercano). */
export function r2Problems(sf: ts.SourceFile, label: string): { problems: string[]; seen: number } {
  const problems: string[] = [];
  const saleCalls = calls(sf, new Set(["runSalesbot"]));
  for (const c of saleCalls) {
    const line = sf.getLineAndCharacterOfPosition(c.getStart()).line + 1;
    const fn = innermostFunction(c);
    const writes = fn
      ? calls(fn, new Set(["writeClientText"])).filter((w) => innermostFunction(w) === fn && w.getStart() < c.getStart())
      : [];
    const nearest = writes.sort((a, b) => b.getStart() - a.getStart())[0];
    if (!nearest) {
      problems.push(`${label}:${line}: runSalesbot sin un writeClientText ANTERIOR en la misma función`);
      continue;
    }
    for (const why of whyWriteDoesNotGate(nearest, c)) problems.push(`${label}:${line}: ${why}`);
  }
  return { problems, seen: saleCalls.length };
}

test("R2: cada runSalesbot va precedido (misma función, mismo flujo) por un await writeClientText que lo frena", () => {
  const bad: string[] = [];
  let seen = 0;
  for (const f of FILES) {
    const r = rel(f);
    if (r === "supabase/functions/_shared/kommo.ts") continue; // la definición
    const res = r2Problems(parse(f), r);
    seen += res.seen;
    bad.push(...res.problems);
  }
  assert.ok(seen >= 3, "no se encontraron los runSalesbot esperados: el análisis dejó de ver los sinks");
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

test("la guardia se prueba a sí misma: R2 detecta cada forma de saltarse el verificador y acepta las correctas", () => {
  const probs = (code: string) => r2Problems(ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true), "x").problems;
  const ok = (code: string) => assert.deepEqual(probs(code), [], code);
  const bad = (code: string, re: RegExp) => {
    const p = probs(code);
    assert.ok(p.length > 0 && p.some((m) => re.test(m)), `${code} → ${JSON.stringify(p)}`);
  };

  // correctos
  ok("async function a(){ await writeClientText({}); await runSalesbot(1,2); }");
  ok("async function a(){ try { await writeClientText({}); await runSalesbot(1,2); } catch (e) { log(e); } }");
  ok("async function a(){ try { await writeClientText({}); } catch (e) { if (x) { log(e); } return; } await runSalesbot(1,2); }");
  ok("async function a(){ try { await writeClientText({}); } catch (e) { throw e; } await runSalesbot(1,2); }");
  ok("async function a(){ for (const v of vs) { await writeClientText(v); } await runSalesbot(1,2); }");
  ok("async function a(){ if (c) { try { await writeClientText({}); await runSalesbot(1,2); } catch {} } await writeClientText({}); await runSalesbot(3,4); }");

  // sin verificador / verificador en otra función
  bad("async function a(){ await runSalesbot(1,2); }", /sin un writeClientText ANTERIOR/);
  bad("async function a(){ await runSalesbot(1,2); } async function b(){ await writeClientText({}); }", /sin un writeClientText ANTERIOR/);
  bad("async function a(){ const f = async () => { await writeClientText({}); }; await runSalesbot(1,2); }", /sin un writeClientText ANTERIOR/);
  // ORDEN: el verificador va después de enviar
  bad("async function a(){ await runSalesbot(1,2); await writeClientText({}); }", /sin un writeClientText ANTERIOR/);
  // sin await: el rechazo no frena a runSalesbot
  bad("async function a(){ writeClientText({}); await runSalesbot(1,2); }", /sin await/);
  bad("async function a(){ await writeClientText({}).catch(() => {}); await runSalesbot(1,2); }", /sin await/);
  // el bloqueo se traga: try/catch que sigue hasta runSalesbot
  bad("async function a(){ try { await writeClientText({}); } catch (e) { log(e); } await runSalesbot(1,2); }", /se traga/);
  // el verificador solo corre en una rama
  bad("async function a(){ if (c) { await writeClientText({}); } await runSalesbot(1,2); }", /no domina/);
  bad("async function a(){ c && await writeClientText({}); await runSalesbot(1,2); }", /no domina|sin await/);
  bad("async function a(){ const t = c ? await writeClientText({}) : null; await runSalesbot(1,2); }", /no domina/);
  // un writeClientText lejano y seguro NO tapa uno cercano que traga el error
  bad(
    "async function a(){ await writeClientText({}); try { await writeClientText({}); } catch (e) { log(e); } await runSalesbot(1,2); }",
    /se traga/,
  );
});
