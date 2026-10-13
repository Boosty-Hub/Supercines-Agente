// _shared/gate-coverage.test.ts
// Guardrail estructural: TODA Edge Function tiene gate interno salvo la lista
// explícita de públicas, y ninguna llama a otra función sin el secreto interno.
// Si agregás una función nueva y no la protegés, este test falla.
//
// Correr con: deno test --allow-read supabase/functions/_shared/gate-coverage.test.ts

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";

const FUNCTIONS_DIR = new URL("../", import.meta.url);

/**
 * Únicas funciones públicas, cada una con su MOTIVO. Kommo no firma sus webhooks
 * ni manda un JWT de Supabase, así que kommo-webhook no puede presentar el secreto
 * interno (ver el encabezado de su index.ts para las mitigaciones).
 */
const PUBLICAS: Record<string, string> = {
  "kommo-webhook": "Kommo no firma sus webhooks y no puede presentar el secreto interno",
};

async function slugs(): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(FUNCTIONS_DIR)) {
    if (e.isDirectory && e.name !== "_shared") out.push(e.name);
  }
  return out.sort();
}

const src = (slug: string) => Deno.readTextFile(new URL(`../${slug}/index.ts`, import.meta.url));

/** Quita comentarios de línea para no contar menciones en texto. */
const sinComentarios = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

Deno.test("hay funciones y la lista de públicas apunta a funciones reales", async () => {
  const all = await slugs();
  assert(all.length >= 10, `solo ${all.length} funciones`);
  for (const publica of Object.keys(PUBLICAS)) assert(all.includes(publica), `${publica} no existe`);
});

Deno.test("toda función no pública llama a authorizeInternal ANTES de hacer trabajo", async () => {
  for (const slug of await slugs()) {
    if (slug in PUBLICAS) continue;
    const code = sinComentarios(await src(slug));
    const serve = code.indexOf("Deno.serve(");
    assert(serve >= 0, `${slug}: no encuentro Deno.serve`);
    const gate = code.indexOf("authorizeInternal(req", serve);
    assert(gate > serve, `${slug}: el handler no llama a authorizeInternal(req, …)`);
    // el gate va antes de leer el cuerpo o tocar la base: nada de req.json()/supabase.from entre el inicio y el gate
    const antes = code.slice(serve, gate);
    assert(!/req\.(json|text|formData)\(/.test(antes), `${slug}: lee el cuerpo antes del gate`);
    assert(!/\.from\(|\.rpc\(/.test(antes), `${slug}: toca la base antes del gate`);
    assert(code.includes('from "../_shared/auth.ts"'), `${slug}: no importa _shared/auth.ts`);
  }
});

Deno.test("las públicas NO tienen gate (si lo tuvieran, Kommo recibiría 401) y están documentadas", async () => {
  for (const slug of Object.keys(PUBLICAS)) {
    const raw = await src(slug);
    assert(!sinComentarios(raw).includes("authorizeInternal("), `${slug} no debe usar authorizeInternal`);
    assert(raw.includes("POR QUÉ ESTA FUNCIÓN ES PÚBLICA"), `${slug}: falta documentar por qué es pública`);
  }
});

Deno.test("ninguna función llama a otra con fetch pelado: siempre callInternal (lleva el secreto)", async () => {
  for (const slug of await slugs()) {
    const code = sinComentarios(await src(slug));
    const m = code.match(/fetch\([^)]*\/functions\/v1\/[^)]*\)/g);
    assertEquals(m, null, `${slug}: fetch directo a /functions/v1/ (usar callInternal de _shared/auth.ts)`);
  }
});

Deno.test("config.toml: verify_jwt=false para TODAS las funciones (invariante 1), incluidas las gateadas", async () => {
  const toml = await Deno.readTextFile(new URL("../../config.toml", import.meta.url));
  for (const slug of await slugs()) {
    const re = new RegExp(`\\[functions\\.${slug}\\]\\s*\\n\\s*verify_jwt\\s*=\\s*false`);
    assert(re.test(toml), `${slug}: falta [functions.${slug}] verify_jwt = false en config.toml`);
  }
});
