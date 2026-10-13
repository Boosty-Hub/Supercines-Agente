// A-S5: el texto de usuario/agente se recorta con truncateGraphemes/firstGrapheme, nunca con
// slice/charAt (parten emojis y dejan surrogates sueltos que Anthropic y Postgres rechazan).
// Correr con: cd web && node --test src/lib/text-slice-usage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appMetadataName } from "./auth/actor.ts";

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("el nombre de app_metadata se recorta a 120 sin partir un emoji ni dejar surrogates sueltos", () => {
  // El emoji (2 unidades UTF-16) cae justo en el límite: 119 'a' + 😀.
  const name = appMetadataName({ full_name: `${"a".repeat(119)}😀 resto` });
  assert.ok(name);
  assert.ok(name.length <= 120);
  assert.equal(LONE.test(name), false);
  // Sin el emoji en el borde, el recorte es el mismo de siempre.
  assert.equal(appMetadataName({ name: "b".repeat(200) })?.length, 120);
  assert.equal(appMetadataName({ name: "  Ana  " }), "Ana");
});

const SRC = fileURLToPath(new URL("../", import.meta.url)); // web/src/

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(n) && !/\.(test|generated)\.tsx?$/.test(n) ? [p] : [];
  });

const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("guardia: ningún .charAt(0) en web/src (las iniciales usan firstGrapheme)", () => {
  const hits = sources(SRC).filter((p) => /\.charAt\(0\)/.test(code(p)));
  assert.deepEqual(hits, []);
});

test("guardia: los módulos que recortan texto de usuario/Kommo no usan .slice(0, n)", () => {
  const files = [join("lib", "auth", "actor.ts"), join("lib", "kommo.ts")];
  const hits = files.filter((f) => /\.slice\(0,/.test(code(join(SRC, f))));
  assert.deepEqual(hits, []);
});
