// Guardia: ninguna llamada a callInternalFunction / triggerInternalFunction puede quedar
// "flotando" (sin await ni return). En serverless la ejecución se congela al devolver la
// Response y un fetch no esperado puede no salir nunca.
//
// Análisis con el AST de TypeScript (no regex): para cada CallExpression del helper se
// sube por la cadena `.catch(...)/.then(...)/.finally(...)` hasta la expresión completa;
// si esa expresión es una sentencia suelta (ExpressionStatement) o `void x`, es flotante.
// Correr con: cd web && node --test src/lib/no-floating-internal-calls.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const GUARDED = new Set(["callInternalFunction", "triggerInternalFunction"]);

type Finding = { line: number; fn: string; callee: string };

function findFloatingCalls(fileName: string, source: string): Finding[] {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const out: Finding[] = [];

  const enclosingFunction = (n: ts.Node): string => {
    for (let p = n.parent; p; p = p.parent) {
      if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name && ts.isIdentifier(p.name)) {
        return p.name.text;
      }
      if (
        ts.isVariableDeclaration(p) &&
        ts.isIdentifier(p.name) &&
        p.initializer &&
        (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))
      ) {
        return p.name.text;
      }
    }
    return "<módulo>";
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && GUARDED.has(node.expression.text)) {
      let top: ts.Node = node;
      // Subir por .catch()/.then()/.finally() encadenados y paréntesis: siguen siendo la misma promesa.
      for (;;) {
        const p = top.parent;
        if (
          p &&
          ts.isPropertyAccessExpression(p) &&
          p.expression === top &&
          p.parent &&
          ts.isCallExpression(p.parent) &&
          p.parent.expression === p
        ) {
          top = p.parent;
        } else if (p && ts.isParenthesizedExpression(p)) {
          top = p;
        } else break;
      }
      const parent = top.parent;
      if (parent && (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent))) {
        out.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          fn: enclosingFunction(node),
          callee: node.expression.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|generated)\.ts$/.test(name)) acc.push(p);
  }
  return acc;
}

test("el detector marca llamadas flotantes y acepta las esperadas", () => {
  const bad = `
    export async function POST() {
      callInternalFunction("a", {}).catch(() => {});
      void triggerInternalFunction("b", {}, "x");
      (callInternalFunction("c")).then(() => {});
    }`;
  const found = findFloatingCalls("bad.ts", bad);
  assert.deepEqual(
    found.map((f) => [f.callee, f.fn]),
    [
      ["callInternalFunction", "POST"],
      ["triggerInternalFunction", "POST"],
      ["callInternalFunction", "POST"],
    ]
  );

  const good = `
    export async function POST() {
      await triggerInternalFunction("a", {}, "x");
      const res = await callInternalFunction("b");
      const p = callInternalFunction("c");
      await Promise.all([p, callInternalFunction("d")]);
      return callInternalFunction("e");
    }
    export const f = () => callInternalFunction("g");`;
  assert.deepEqual(findFloatingCalls("good.ts", good), []);
});

test("ninguna route ni lib deja callInternalFunction/triggerInternalFunction sin await", () => {
  const root = join(import.meta.dirname, "..");
  const problems: string[] = [];
  for (const file of walk(root)) {
    for (const f of findFloatingCalls(file, readFileSync(file, "utf8"))) {
      problems.push(`${relative(root, file)}:${f.line} en ${f.fn}() llama ${f.callee} sin await`);
    }
  }
  assert.deepEqual(problems, []);
});
