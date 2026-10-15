// Secretos atados a un destino: solo runtime_config, sin fallback al entorno.
// Correr con: cd web && node --test src/lib/db-only-secret-keys.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DB_ONLY_SECRET_KEYS, isDbOnlySecretKey } from "./db-only-secret-keys.ts";
import { SECRET_BOUND_PAIRS } from "./secret-bound-config.ts";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

test("la lista coincide EXACTAMENTE con los secretos de los pares destino+secreto", () => {
  const delPares = new Set(SECRET_BOUND_PAIRS.flatMap((p) => [...p.secretKeys]));
  assert.deepEqual([...DB_ONLY_SECRET_KEYS].sort(), [...delPares].sort());
});

test("clasificación: secretos atados y TOOL_<X> sí; TOOL_<X>_HOSTS y el resto no", () => {
  for (const k of [...DB_ONLY_SECRET_KEYS, "TOOL_ERP", "TOOL_A1_B2"]) assert.equal(isDbOnlySecretKey(k), true, k);
  for (const k of ["TOOL_ERP_HOSTS", "KOMMO_API_DOMAIN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SUPABASE_URL", "tool_x", "TOOL_", "constructor"]) {
    assert.equal(isDbOnlySecretKey(k), false, k);
  }
});

test("paridad: la copia de las Edge Functions es idéntica a la de la web", () => {
  const body = (s: string) => s.slice(s.indexOf("export const DB_ONLY_SECRET_KEYS = [")).replace(/\s+/g, " ").trim();
  const web = readFileSync(here("./db-only-secret-keys.ts"), "utf8");
  const edge = readFileSync(here("../../../supabase/functions/_shared/db-only-secret-keys.ts"), "utf8");
  assert.equal(body(edge), body(web));
});

test("guardia: runtime-config (web) y config (Edge) aplican la regla en sus lecturas con fallback al entorno", () => {
  const web = readFileSync(here("./runtime-config.ts"), "utf8");
  assert.ok(/function envFallback[\s\S]*isDbOnlySecretKey/.test(web), "web: envFallback decide por isDbOnlySecretKey");
  // ninguna lectura de process.env[key] fuera de envFallback
  const fuera = web.replace(/function envFallback[\s\S]*?\n}\n/, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/process\.env\[key\]/.test(fuera), "web: lectura directa de process.env[key] fuera de envFallback");
  const edge = readFileSync(here("../../../supabase/functions/_shared/config.ts"), "utf8");
  assert.ok(/isDbOnlySecretKey\(key\) \? undefined : envGet\(key\)/.test(edge), "Edge: get() sin fallback al entorno para secretos atados");
});
