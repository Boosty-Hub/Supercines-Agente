// Autoría de auditoría: nunca desde user_metadata (lo edita el propio usuario).
// Correr con: cd web && node --test src/lib/actor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appMetadataName, displayActor, trustedActorName } from "./auth/actor.ts";

test("trustedActorName: app_metadata → email → «usuario»; user_metadata ni se mira", () => {
  assert.equal(trustedActorName({ email: "ana@x.com", app_metadata: { full_name: "Ana Pérez" } }), "Ana Pérez");
  assert.equal(trustedActorName({ email: "ana@x.com", app_metadata: { name: "  Ana  " } }), "Ana");
  assert.equal(trustedActorName({ email: "ana@x.com", app_metadata: {} }), "ana@x.com");
  assert.equal(trustedActorName({ email: null, app_metadata: null }), "usuario");
  // un nombre que no es string (dato raro) no se usa
  assert.equal(trustedActorName({ email: "a@x.com", app_metadata: { full_name: { x: 1 } } }), "a@x.com");
});

test("un usuario NO puede presentarse como otro: la función ni recibe user_metadata", () => {
  // La firma solo acepta email y app_metadata; si alguien pasara el objeto user entero con
  // user_metadata.full_name = "Dueño", ese campo no influye en el resultado.
  const user = { email: "mallory@x.com", app_metadata: {}, user_metadata: { full_name: "Dueño" } };
  assert.equal(trustedActorName(user), "mallory@x.com");
  assert.equal(appMetadataName({}), null);
});

test("displayActor: gana el nombre resuelto por id; si el usuario ya no existe, la instantánea", () => {
  const byId = new Map([["u1", "ana@x.com (desde el panel)"]]);
  assert.equal(displayActor("u1", "Dueño (desde el panel)", byId), "ana@x.com (desde el panel)");
  assert.equal(displayActor(null, "Ana (desde el panel)", byId), "Ana (desde el panel)");
  assert.equal(displayActor("borrado", "Ana (desde el panel)", byId), "Ana (desde el panel)");
  assert.equal(displayActor(null, null, byId), null);
});


// ─── Guardia: user_metadata no se usa para autoría ni autorización ───
//
// ALCANCE: el código ESCRITO a mano del repo que corre con privilegios: web/src y las Edge
// Functions (supabase/functions). Quedan fuera los archivos de codegen (`*.generated.ts`, están
// gitignoreados y embeben SQL/TS de otros directorios: reescanearlos solo duplicaría hallazgos
// y haría depender el test de que existan o no) y los tests. El walker NO depende de que los
// generados estén presentes ni ausentes.
const GENERATED = /\.generated\.tsx?$/;
const SOURCE = /\.(ts|tsx)$/;

/** Rutas con código fuente (no test, no generado) bajo `dir` que usan `user_metadata` fuera de comentarios. */
export function findUserMetadataUses(dir: string, allow: readonly string[] = []): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (name !== "node_modules" && name !== ".next") walk(p);
        continue;
      }
      if (!SOURCE.test(name) || GENERATED.test(name) || /\.test\.tsx?$/.test(name) || allow.some((a) => p.endsWith(a))) continue;
      // se ignoran los comentarios de línea/bloque que explican por qué NO se usa
      const code = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/user_metadata/.test(code)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

test("guardia: user_metadata no se usa en web/src ni en las Edge Functions (autoría ni autorización)", () => {
  const webSrc = fileURLToPath(new URL("../", import.meta.url)); // web/src/
  const edge = fileURLToPath(new URL("../../../supabase/functions/", import.meta.url));
  const allow = [join("auth", "actor.ts")]; // el módulo que documenta por qué NO se usa
  assert.deepEqual(findUserMetadataUses(webSrc, allow), []);
  assert.deepEqual(findUserMetadataUses(edge), []);
});

test("guardia (auto-prueba): detecta un uso real, ignora comentarios, tests y archivos generados", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-guard-"));
  try {
    writeFileSync(join(dir, "ok-comment.ts"), "// user_metadata se edita solo\n/* user_metadata */\nexport const a = 1;\n");
    writeFileSync(join(dir, "mal.ts"), "export const n = (u: any) => u.user_metadata.full_name;\n");
    writeFileSync(join(dir, "mal.generated.ts"), "export const s = 'user_metadata';\n");
    writeFileSync(join(dir, "mal.test.ts"), "export const s = 'user_metadata';\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "mal2.tsx"), "export const x = (u: any) => u.user_metadata;\n");
    assert.deepEqual(findUserMetadataUses(dir).map((p) => p.slice(dir.length + 1)).sort(), ["mal.ts", join("sub", "mal2.tsx")]);
    // un nombre que solo CONTIENE «.generated.» pero no es codegen sí se escanea
    writeFileSync(join(dir, "foo.generated.helper.ts"), "export const s = u.user_metadata;\n");
    assert.ok(findUserMetadataUses(dir).some((p) => p.endsWith("foo.generated.helper.ts")));
    // la lista de permitidos exime solo ese archivo
    assert.deepEqual(findUserMetadataUses(dir, ["mal.ts", join("sub", "mal2.tsx"), "foo.generated.helper.ts"]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
