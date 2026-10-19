// Huella de las Edge Functions: el codegen (web) y el registro tras un deploy por CLI
// tienen que calcular EXACTAMENTE lo mismo, y el registro solo vale si lo desplegado = repo.
// Correr con: cd web && node --test scripts/function-bundles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hashFiles, readFunctionBundles } from "./lib/function-bundles.mjs";
import { diffDeployed, mergeHashesSql } from "./record-function-hashes.mjs";

const here = new URL(".", import.meta.url);

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "fb-test-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

test("el algoritmo de huella está fijado (cambiarlo invalida todo lo registrado en los clientes)", () => {
  assert.equal(hashFiles([{ path: "b/index.ts", body: "x" }, { path: "_shared/a.ts", body: "ñ" }]), "399ad3b64040ec6d");
  // independiente del orden de entrada
  assert.equal(hashFiles([{ path: "_shared/a.ts", body: "ñ" }, { path: "b/index.ts", body: "x" }]), "399ad3b64040ec6d");
});

test("el codegen y el registro usan el MISMO módulo (sin una huella propia)", () => {
  const embed = readFileSync(new URL("embed-provision.mjs", here), "utf8");
  const record = readFileSync(new URL("record-function-hashes.mjs", here), "utf8");
  for (const src of [embed, record]) {
    assert.match(src, /from "\.\/lib\/function-bundles\.mjs"/);
    assert.doesNotMatch(src, /createHash/);
  }
});

test("bundle = index.ts + _shared/ sin tests, en DEPLOY_ORDER; una función sin lugar rompe", () => {
  const root = tree({ "embed/index.ts": "e", "kommo-webhook/index.ts": "k", "_shared/a.ts": "a", "_shared/a.test.ts": "t" });
  try {
    const b = readFunctionBundles(root);
    assert.deepEqual(b.map((x) => x.slug), ["kommo-webhook", "embed"]);
    assert.deepEqual(b[1].files.map((f) => f.path), ["embed/index.ts", "_shared/a.ts"]);
    assert.equal(b[1].hash, hashFiles(b[1].files));
    mkdirSync(join(root, "nueva"));
    writeFileSync(join(root, "nueva/index.ts"), "n");
    assert.throws(() => readFunctionBundles(root), /DEPLOY_ORDER/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diffDeployed: idéntico → []; distinto, sobrante o sin entrypoint → problema", () => {
  const repo = tree({ "embed/index.ts": "e", "_shared/a.ts": "a", "_shared/no-importado.ts": "z" });
  const same = tree({ "embed/index.ts": "e", "_shared/a.ts": "a" }); // el CLI solo baja lo importado
  const changed = tree({ "embed/index.ts": "e", "_shared/a.ts": "A" });
  const extra = tree({ "embed/index.ts": "e", "_shared/viejo.ts": "v" });
  const noIndex = tree({ "_shared/a.ts": "a" });
  try {
    assert.deepEqual(diffDeployed("embed", same, repo), []);
    assert.match(diffDeployed("embed", changed, repo).join(), /_shared\/a\.ts: distinto/);
    assert.match(diffDeployed("embed", extra, repo).join(), /no existe en el repo/);
    assert.match(diffDeployed("embed", noIndex, repo).join(), /index\.ts no está/);
  } finally {
    for (const d of [repo, same, changed, extra, noIndex]) rmSync(d, { recursive: true, force: true });
  }
});

test("mergeHashesSql fusiona y rechaza lo que no es slug/hex", () => {
  const sql = mergeHashesSql({ embed: "0123456789abcdef" });
  assert.match(sql, /'\{"embed":"0123456789abcdef"\}'/);
  assert.match(sql, /\|\| excluded\.value::jsonb/);
  assert.throws(() => mergeHashesSql({ "x'; drop": "0123456789abcdef" }));
  assert.throws(() => mergeHashesSql({ embed: "zz" }));
});
