// Tests del rename del agente: la versión que genera debe poder registrarse (W3a).
// Correr con: cd web && node --test src/lib/agent-rename.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renameAgentVersioned, versionToRecordAfterRename } from "./agent-rename.ts";
import { detectPromptConflict, hashPrompt } from "./agent-prompt-sync.ts";

const conflict = new Error("409");
const isVersionConflict = (e: unknown) => e === conflict;

test("rename que SUBE la versión: devuelve before/after con la de la respuesta", async () => {
  let live = 7;
  const r = await renameAgentVersioned({
    retrieve: async () => ({ version: live }),
    update: async (v) => {
      assert.equal(v, 7);
      live = 8;
      return { version: 8 };
    },
    isVersionConflict,
  });
  assert.deepEqual(r, { before: 7, after: 8 });
});

test("rename que NO sube la versión: after == before (correcto en ambos casos)", async () => {
  const r = await renameAgentVersioned({
    retrieve: async () => ({ version: 7 }),
    update: async () => ({ version: 7 }),
    isVersionConflict,
  });
  assert.deepEqual(r, { before: 7, after: 7 });
});

test("respuesta sin versión: se RELEE la vigente del agente", async () => {
  let live = 3;
  const r = await renameAgentVersioned({
    retrieve: async () => ({ version: live }),
    update: async () => {
      live = 4;
      return {};
    },
    isVersionConflict,
  });
  assert.deepEqual(r, { before: 3, after: 4 });
});

test("409 por escritura concurrente: relee la versión y reintenta UNA vez", async () => {
  let live = 5;
  let calls = 0;
  const r = await renameAgentVersioned({
    retrieve: async () => ({ version: live }),
    update: async (v) => {
      calls++;
      if (calls === 1) {
        live = 6; // otro escritor se adelantó
        throw conflict;
      }
      assert.equal(v, 6);
      live = 7;
      return { version: 7 };
    },
    isVersionConflict,
  });
  assert.equal(calls, 2);
  assert.deepEqual(r, { before: 6, after: 7 });
});

test("un error que no es 409 se propaga sin reintentar", async () => {
  let calls = 0;
  await assert.rejects(
    renameAgentVersioned({
      retrieve: async () => ({ version: 1 }),
      update: async () => {
        calls++;
        throw new Error("500");
      },
      isVersionConflict,
    }),
    /500/,
  );
  assert.equal(calls, 1);
});

test("versionToRecordAfterRename: registra la nueva si estaba al día", () => {
  assert.equal(versionToRecordAfterRename({ registered: 7, result: { before: 7, after: 8 } }), 8);
});

test("versionToRecordAfterRename: NO registra si el agente ya estaba por delante (taparía una edición externa)", () => {
  assert.equal(versionToRecordAfterRename({ registered: 7, result: { before: 9, after: 10 } }), null);
});

test("versionToRecordAfterRename: sin versión registrada o sin versión nueva no registra nada", () => {
  assert.equal(versionToRecordAfterRename({ registered: null, result: { before: 7, after: 8 } }), null);
  assert.equal(versionToRecordAfterRename({ registered: 7, result: { before: 7, after: null } }), null);
});

test("ciclo completo: rename + registro + sync siguiente NO da falso conflicto de versión", () => {
  const system = "Sos Acme.\n\n---\n\n## Flujo obligatorio antes de redactar\n\nX\n";
  const base = { liveSystem: system, liveVersion: 8, syncedHash: hashPrompt(system), composedSystem: system };
  // sin registrar la versión del rename: falso conflicto
  assert.equal(detectPromptConflict({ ...base, registeredVersion: 7 })?.kind, "version_ahead");
  // registrando lo que devolvió el rename: sin conflicto
  const registered = versionToRecordAfterRename({ registered: 7, result: { before: 7, after: 8 } });
  assert.equal(detectPromptConflict({ ...base, registeredVersion: registered }), null);
});
