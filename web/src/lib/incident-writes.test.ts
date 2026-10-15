// GUARDIA: cerrar un incidente de salud (`system_incidents.resolved_at`) desde el panel va con el
// cliente de SERVICIO y revisando el error. La RLS (0078/0079) solo deja a la sesión silenciar
// (`muted_until/muted_by`); un update de `resolved_at` con la sesión no cierra nada y, sin mirar
// el `error`, la ruta respondía «ok» con el incidente todavía abierto.
// Correr con: cd web && node --test src/lib/incident-writes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f)) out.push(p);
  }
  return out;
}

const CIERRE = /(?:const\s*\{\s*error:\s*(\w+)\s*\}\s*=\s*await\s+(\w+)\s*)?\.from\(\s*["']system_incidents["']\s*\)\s*\.update\(\s*\{\s*resolved_at/g;

test("cerrar system_incidents desde el panel: cliente de servicio y error revisado", () => {
  const mal: string[] = [];
  let vistos = 0;
  for (const p of walk(SRC)) {
    const src = readFileSync(p, "utf8");
    const rel = relative(SRC, p).split(sep).join("/");
    for (const m of src.matchAll(CIERRE)) {
      vistos++;
      const [, errVar, cliente] = m;
      if (!errVar || !cliente) {
        mal.push(`${rel}: el update de resolved_at no captura el error ({ error } = await <cliente>.from(...))`);
        continue;
      }
      if (!new RegExp(`const\\s+${cliente}\\s*=\\s*createServiceClient\\(\\)`).test(src)) {
        mal.push(`${rel}: '${cliente}' no es el cliente de servicio (createServiceClient())`);
      }
      if (!new RegExp(`if\\s*\\(\\s*${errVar}\\s*\\)`).test(src)) mal.push(`${rel}: no revisa '${errVar}'`);
    }
  }
  assert.ok(vistos > 0, "no se encontró ningún cierre de incidente (¿cambió la forma del código?)");
  assert.deepEqual(mal, []);
});
