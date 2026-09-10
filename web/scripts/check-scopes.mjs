#!/usr/bin/env node
// Guardrail: toda ruta del panel tiene que declarar su alcance.
//
// POR QUÉ EXISTE. `PATH_SCOPES` (src/lib/auth/roles.ts) es una lista de
// prefijos y `scopeRequeridoPara` devuelve `null` para lo que no encuentra —
// o sea, una ruta que nadie agregó a la lista NO queda protegida: queda
// ABIERTA a cualquier alcance, incluido `operacion`. El fallo es silencioso:
// nada se rompe, nada avisa, la ruta simplemente deja de estar gateada.
//
// Y no es hipotético. En uno de los clones de este template la lista quedó
// vieja frente a rutas agregadas después (`/api/promotions`, `/api/kb`,
// `/api/voz`) y quedaron alcanzables por cualquiera con sesión, sin que nadie
// lo notara: no aparecían ni en el menú.
//
// Este script recorre las páginas del dashboard y las rutas de API reales del
// árbol de archivos, y falla el build si alguna no cae bajo ningún prefijo.
// Arreglarlo es agregar una línea a PATH_SCOPES — la decisión de a qué alcance
// pertenece la ruta la toma una persona, no este script.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const APP = join(WEB, "src", "app");
const ROLES = join(WEB, "src", "lib", "auth", "roles.ts");

// Rutas públicas por diseño: no exigen sesión, así que tampoco alcance.
// El middleware las deja pasar antes de llegar al gate (ver `isPublic`).
const PUBLICAS = ["/login", "/first-run", "/auth", "/update-password"];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** `src/app/(dashboard)/config/kommo/page.tsx` → `/config/kommo` */
function toRoute(file) {
  const rel = relative(APP, file).replace(/\\/g, "/");
  const sinArchivo = rel.replace(/(^|\/)(page|route)\.tsx?$/, "");
  const segmentos = sinArchivo
    .split("/")
    .filter((s) => s && !(s.startsWith("(") && s.endsWith(")"))); // grupos de rutas
  return "/" + segmentos.join("/");
}

function prefijosDeclarados() {
  const src = readFileSync(ROLES, "utf8");
  const bloque = src.slice(src.indexOf("PATH_SCOPES"));
  const prefijos = [...bloque.matchAll(/prefix:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (prefijos.length === 0) {
    console.error("check-scopes: no encontré ningún `prefix:` en PATH_SCOPES. ¿Cambió el formato?");
    process.exit(1);
  }
  return prefijos;
}

const prefijos = prefijosDeclarados();
const cubre = (ruta) =>
  prefijos.some((p) => ruta === p || ruta.startsWith(p + "/")) ||
  PUBLICAS.some((p) => ruta === p || ruta.startsWith(p + "/"));

const rutas = walk(APP)
  .filter((f) => /\/(page|route)\.tsx?$/.test(f))
  .map(toRoute)
  .filter((r) => r !== "/") // la raíz redirige, no es una pantalla
  .sort();

const huerfanas = [...new Set(rutas.filter((r) => !cubre(r)))];

if (huerfanas.length > 0) {
  console.error("\n✖ check-scopes: estas rutas no declaran alcance y quedan ABIERTAS a cualquier usuario con sesión:\n");
  for (const r of huerfanas) console.error("    " + r);
  console.error("\n  Agregá cada una a PATH_SCOPES en src/lib/auth/roles.ts con el alcance que le corresponde.\n");
  process.exit(1);
}

console.log(`✔ check-scopes: ${rutas.length} rutas, todas con alcance declarado.`);
