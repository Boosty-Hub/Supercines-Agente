// scripts/lib/function-bundles.mjs
// Arma los bundles de las Edge Functions (index.ts + todo _shared/) y su huella.
// Lo usan DOS consumidores que tienen que coincidir byte a byte:
//   - embed-provision.mjs: embebe los bundles en la web (el panel compara su `hash`
//     contra runtime_config.DEPLOYED_FUNCTION_HASHES para decir «al día» o «falta»).
//   - record-function-hashes.mjs: registra esa misma huella tras un deploy por CLI.
// Si cada uno calculara la huella por su cuenta, el registro de un deploy por CLI no
// coincidiría nunca con lo que compara la web (KIA, oct-2026: count 0 con hashes cargados).

import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

// ORDEN DE DESPLIEGUE: INVOCADORES antes que INVOCADOS. Las funciones internas
// exigen el secreto x-internal-secret (_shared/auth.ts) y las que se llaman entre
// sí lo mandan. Durante un despliegue función por función, si el invocado (ya con
// gate) se desplegara antes que su invocador (viejo, sin secreto), esa llamada
// recibiría 401 hasta que el invocador se actualice. Desplegando de la cabeza de la
// cadena hacia las hojas, cuando una función empieza a exigir el secreto, quienes
// la llaman ya lo mandan. Cadena: kommo-webhook → process-inbound → generate-response
// → (embed | publish-to-kommo → evaluate-outcomes); el resto solo las llama pg_cron.
// Una función NUEVA tiene que figurar acá (el build falla si no): decidir su lugar es
// una decisión de diseño, no un accidente del orden alfabético.
export const DEPLOY_ORDER = [
  "kommo-webhook",
  "process-inbound",
  "generate-response",
  "publish-to-kommo",
  "follow-up-scan",
  "dreams-run",
  "alerts-scan",
  "health-scan",
  "sync-pipelines",
  "kommo-funnel-sync", // solo pg_cron (SuperCines)
  "evaluate-outcomes",
  "embed",
  "cartelera", // la llama el agente (tool http de generate-response): invocado, va al final
];

/** Hash determinista del contenido de una función (sus archivos). 16 hex. */
export function hashFiles(files) {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path);
    h.update("\0");
    h.update(f.body);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/**
 * Lee supabase/functions y devuelve los bundles en DEPLOY_ORDER.
 * Lanza (con mensaje para humanos) ante una función sin lugar en DEPLOY_ORDER o sin index.ts.
 */
export function readFunctionBundles(functionsDir, order = DEPLOY_ORDER) {
  if (!existsSync(functionsDir)) throw new Error(`functions directory not found at: ${functionsDir}`);
  const sharedDir = join(functionsDir, "_shared");

  // _shared/ va completo en cada bundle (sibling de <slug>/: desde "<slug>/index.ts",
  // "../_shared/config.ts" resuelve a "_shared/config.ts" en la raíz del bundle; un
  // index.ts en la raíz haría que "../_shared" se escape y la función no arranque).
  const sharedFiles = existsSync(sharedDir)
    ? readdirSync(sharedDir)
        // Los tests no son parte del runtime: subirlos en CADA bundle de función
        // es peso muerto y arrastra imports (deno.land/std) que el deployer no
        // necesita resolver.
        .filter((f) => !f.startsWith(".") && !f.endsWith(".test.ts"))
        .map((filename) => ({ path: `_shared/${filename}`, body: readFileSync(join(sharedDir, filename), "utf8") }))
    : [];

  const discovered = readdirSync(functionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_shared")
    .map((d) => d.name);
  const missingFromOrder = discovered.filter((s) => !order.includes(s));
  if (missingFromOrder.length > 0) {
    throw new Error(
      `función(es) sin lugar en DEPLOY_ORDER (scripts/lib/function-bundles.mjs): ${missingFromOrder.join(", ")}.\n` +
        `Agregalas respetando invocadores antes que invocados.`
    );
  }
  const slugs = order.filter((s) => discovered.includes(s));
  if (slugs.length === 0) throw new Error(`No function directories found in ${functionsDir}`);

  return slugs.map((slug) => {
    const indexPath = join(functionsDir, slug, "index.ts");
    if (!existsSync(indexPath)) throw new Error(`Missing index.ts for function '${slug}' at: ${indexPath}`);
    const files = [{ path: `${slug}/index.ts`, body: readFileSync(indexPath, "utf8") }, ...sharedFiles];
    return { slug, entrypoint: `${slug}/index.ts`, files, hash: hashFiles(files) };
  });
}
