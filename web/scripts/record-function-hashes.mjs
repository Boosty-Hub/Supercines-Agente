#!/usr/bin/env node
// record-function-hashes.mjs
// Registra la huella de las Edge Functions desplegadas POR CLI en
// runtime_config.DEPLOYED_FUNCTION_HASHES, la misma que compara el panel
// (/api/provision/status y el centro de actualizaciones).
//
// Por qué existe: el wizard y el centro de updates registran la huella al desplegar,
// pero `supabase functions deploy` no sabe nada de ese registro. Tras un deploy por CLI
// el panel veía TODAS las funciones como «faltantes» (count 0) y ofrecía redesplegarlas:
// con una web vieja publicada, eso revierte las funciones a su código embebido.
//
// Qué hace, por función:
//   1) baja el código DESPLEGADO (`supabase functions download --use-api`, sin Docker)
//      y lo compara byte a byte con supabase/functions del repo;
//   2) verifica verify_jwt=false (invariante 1 del CLAUDE.md);
//   3) solo si ambos dan bien, registra la huella que calcula la web para ese código
//      (scripts/lib/function-bundles.mjs, el mismo módulo que usa el codegen).
// Nunca registra una huella que no corresponde a lo que corre en Supabase.
// Si se pasa --site, al final consulta /api/provision/status: count = total confirma que la
// web PUBLICADA embebe este mismo código (si no, la web está en otra versión: redesplegarla).
//
// Uso (desde la raíz del repo o desde web/), tras `supabase functions deploy ... --no-verify-jwt`:
//   SUPABASE_ACCESS_TOKEN=sbp_... node web/scripts/record-function-hashes.mjs \
//     --project-ref <ref> [--site https://<sitio>] [--dry-run] [slug ...]
// Sin slugs = todas. El token nunca se imprime.

import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { readFunctionBundles } from "./lib/function-bundles.mjs";

const MGMT = "https://api.supabase.com";
const KEY = "DEPLOYED_FUNCTION_HASHES";
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const HASH_RE = /^[0-9a-f]{16}$/;

/** Lista recursiva de archivos (rutas relativas a `root`, con "/"). */
export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p).split("\\").join("/"));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/**
 * Compara el código bajado de Supabase (`downloadedFunctionsDir`, el `functions/` del
 * download) con el del repo. Devuelve las diferencias; [] = idéntico.
 * Cuenta todo lo que corre: cada archivo desplegado debe existir igual en el repo, y el
 * entrypoint del slug debe estar.
 */
export function diffDeployed(slug, downloadedFunctionsDir, repoFunctionsDir) {
  const files = listFiles(downloadedFunctionsDir);
  const problems = [];
  if (!files.includes(`${slug}/index.ts`)) problems.push(`${slug}/index.ts no está en lo desplegado`);
  for (const rel of files) {
    const repoPath = join(repoFunctionsDir, rel);
    if (!existsSync(repoPath)) {
      problems.push(`${rel}: desplegado pero no existe en el repo`);
      continue;
    }
    if (!readFileSync(repoPath).equals(readFileSync(join(downloadedFunctionsDir, rel)))) {
      problems.push(`${rel}: distinto del repo`);
    }
  }
  return problems;
}

/** SQL que FUSIONA las huellas nuevas con las registradas (las demás no se tocan). */
export function mergeHashesSql(hashes) {
  for (const [slug, hash] of Object.entries(hashes)) {
    if (!SLUG_RE.test(slug) || !HASH_RE.test(hash)) throw new Error(`huella inválida: ${slug}=${hash}`);
  }
  const json = JSON.stringify(hashes); // solo slugs y hex validados: sin comillas simples
  return (
    `insert into public.runtime_config (key, value, updated_by, updated_at) ` +
    `values ('${KEY}', '${json}', 'cli-deploy', now()) ` +
    `on conflict (key) do update set value = ((case when runtime_config.value ~ '^\\s*\\{' ` +
    `then runtime_config.value::jsonb else '{}'::jsonb end) || excluded.value::jsonb)::text, ` +
    `updated_by = excluded.updated_by, updated_at = now() returning value`
  );
}

function parseArgs(argv) {
  const a = { slugs: [], dryRun: false, ref: null, site: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--project-ref") a.ref = argv[++i];
    else if (v === "--site") a.site = argv[++i];
    else if (v === "--dry-run") a.dryRun = true;
    else if (v.startsWith("--")) throw new Error(`opción desconocida: ${v}`);
    else a.slugs.push(v);
  }
  if (!a.ref || !/^[a-z0-9]{20}$/.test(a.ref)) throw new Error("falta --project-ref <ref> (20 caracteres)");
  return a;
}

async function mgmt(path, token, init = {}) {
  const res = await fetch(`${MGMT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status} en ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function download(slug, ref, token) {
  const dir = mkdtempSync(join(tmpdir(), `fn-${slug}-`));
  const r = spawnSync(
    "npx",
    ["--yes", "supabase", "functions", "download", slug, "--project-ref", ref, "--use-api", "--workdir", dir],
    { env: { ...process.env, SUPABASE_ACCESS_TOKEN: token }, encoding: "utf8" }
  );
  if (r.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`no se pudo bajar ${slug}: ${(r.stderr || r.stdout || "").slice(-300)}`);
  }
  return dir;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("falta SUPABASE_ACCESS_TOKEN en el entorno");

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const functionsDir = join(repoRoot, "supabase/functions");

  // La web publicada se construye desde git: con cambios sin commitear, la huella local no es
  // la que va a embeber ninguna web.
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "supabase/functions"], { cwd: repoRoot, encoding: "utf8" });
  if (dirty.status === 0 && dirty.stdout.trim()) {
    throw new Error(`supabase/functions tiene cambios sin commitear:\n${dirty.stdout}Commiteá (y pusheá) antes de registrar.`);
  }

  const bundles = readFunctionBundles(functionsDir);
  const wanted = args.slugs.length ? args.slugs : bundles.map((b) => b.slug);
  const unknown = wanted.filter((s) => !bundles.some((b) => b.slug === s));
  if (unknown.length) throw new Error(`slug(s) que no están en el repo: ${unknown.join(", ")}`);

  const live = await mgmt(`/v1/projects/${args.ref}/functions`, token);
  const liveBySlug = new Map(live.map((f) => [f.slug, f]));

  const toRecord = {};
  const failed = [];
  for (const slug of wanted) {
    const fn = liveBySlug.get(slug);
    if (!fn) { failed.push(`${slug}: no está desplegada`); continue; }
    if (fn.verify_jwt !== false) { failed.push(`${slug}: verify_jwt=${fn.verify_jwt} (debe ser false; redesplegá con --no-verify-jwt)`); continue; }
    const dir = download(slug, args.ref, token);
    try {
      const problems = diffDeployed(slug, join(dir, "supabase/functions"), functionsDir);
      if (problems.length) { failed.push(`${slug}: lo desplegado no es el repo → ${problems.join("; ")}`); continue; }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    toRecord[slug] = bundles.find((b) => b.slug === slug).hash;
    console.log(`ok  ${slug} v${fn.version} = repo → ${toRecord[slug]}`);
  }
  for (const f of failed) console.error(`NO  ${f}`);

  if (Object.keys(toRecord).length && !args.dryRun) {
    await mgmt(`/v1/projects/${args.ref}/database/query`, token, {
      method: "POST",
      body: JSON.stringify({ query: mergeHashesSql(toRecord) }),
    });
    console.log(`registradas ${Object.keys(toRecord).length} huella(s) en runtime_config.${KEY}`);
  } else if (args.dryRun) {
    console.log("(dry-run: no se registró nada)");
  }

  if (args.site) {
    const st = await fetch(`${args.site.replace(/\/$/, "")}/api/provision/status`, { redirect: "manual" });
    if (st.status !== 200) {
      console.error(`status: HTTP ${st.status} (${st.headers.get("location") ?? ""}) — la ruta debe ser pública`);
    } else {
      const fd = (await st.json()).functionsDeployed;
      console.log(`web publicada: ${fd.count}/${fd.total}${fd.missing.length ? ` — distintas de la web: ${fd.missing.join(", ")}` : ""}`);
      if (fd.missing.length) process.exitCode = 1;
    }
  }
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  });
}
