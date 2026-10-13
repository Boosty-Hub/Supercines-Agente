// Tests de interpretSyncResponse. Correr con: cd web && node --test src/lib/sync-response.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretSyncResponse } from "./sync-response.ts";

const conflict = { kind: "prompt_changed", diff: [], live: { version: 3, operatorPrompt: "x" } };

test("200 ok -> ok", () => {
  assert.deepEqual(interpretSyncResponse(200, { ok: true, version: 4 }), { kind: "ok" });
});

test("409 con conflicto -> conflict (la UI muestra el panel de resolución, no el error crudo)", () => {
  const out = interpretSyncResponse(409, { ok: false, error: "El prompt fue modificado fuera", conflict });
  assert.equal(out.kind, "conflict");
  assert.deepEqual(out.kind === "conflict" && out.conflict, conflict);
});

test("409 SIN conflicto no se confunde con uno: es un error con su mensaje", () => {
  assert.deepEqual(interpretSyncResponse(409, { ok: false, error: "versión desfasada" }), {
    kind: "error",
    message: "versión desfasada",
  });
});

test("errores: mensaje del servidor, o HTTP <status> si no hay cuerpo útil", () => {
  assert.deepEqual(interpretSyncResponse(502, { ok: false, error: "No hay agente aprovisionado" }), {
    kind: "error",
    message: "No hay agente aprovisionado",
  });
  assert.deepEqual(interpretSyncResponse(500, null), { kind: "error", message: "HTTP 500" });
  assert.deepEqual(interpretSyncResponse(200, { ok: false }), { kind: "error", message: "HTTP 200" });
});
