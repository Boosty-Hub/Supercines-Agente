// Autoría de auditoría: nunca desde user_metadata (lo edita el propio usuario).
// Correr con: cd web && node --test src/lib/actor.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

test("guardia: user_metadata no se usa en código de web/ (autoría ni autorización)", () => {
  const root = fileURLToPath(new URL("../", import.meta.url)); // web/src/
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "node_modules") walk(p);
      } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") && !p.endsWith(join("auth", "actor.ts"))) {
        const code = readFileSync(p, "utf8");
        // se ignoran los comentarios de línea/bloque que explican por qué NO se usa
        const sinComentarios = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/user_metadata/.test(sinComentarios)) hits.push(p);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
