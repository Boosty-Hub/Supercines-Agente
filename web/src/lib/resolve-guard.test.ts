// Tests de la guardia TOCTOU de la resolución de conflictos (B-W3).
// Correr con: cd web && node --test src/lib/resolve-guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkResolveHash, detectPromptConflict, hashPrompt } from "./agent-prompt-sync.ts";
import { guardedPush, type PushBaseline } from "./guarded-push.ts";
import { interpretSyncResponse } from "./sync-response.ts";

const SC = "---\n\n## Flujo obligatorio antes de redactar\n\nX\n";
const sys = (op: string) => `${op}\n\n${SC}`;

test("el conflicto trae liveHash = hash del system vivo mostrado", () => {
  const live = sys("Vivo editado");
  const c = detectPromptConflict({
    liveSystem: live,
    liveVersion: 2,
    syncedHash: hashPrompt(sys("Lo anterior")),
    registeredVersion: 2,
    composedSystem: sys("DB"),
  });
  assert.equal(c?.liveHash, hashPrompt(live));
});

test("checkResolveHash: hash igual → ok; distinto → stale; ausente → missing_hash", () => {
  const live = sys("Vivo");
  assert.deepEqual(checkResolveHash(hashPrompt(live), live), { ok: true });
  // Fin de línea y espacios finales no cuentan como cambio (mismo normalize que el hash).
  assert.deepEqual(checkResolveHash(hashPrompt(live), `${live.replace(/\n/g, "\r\n")}  `), { ok: true });
  assert.deepEqual(checkResolveHash(hashPrompt(live), sys("Vivo, cambiado entre tanto")), { ok: false, reason: "stale" });
  assert.deepEqual(checkResolveHash(undefined, live), { ok: false, reason: "missing_hash" });
  assert.deepEqual(checkResolveHash("", live), { ok: false, reason: "missing_hash" });
  assert.deepEqual(checkResolveHash(hashPrompt(live), null), { ok: false, reason: "stale" });
});

// ─── overwrite: la guardia vive dentro de guardedPush ───

type Live = { version: number; system: string };
const baseline: PushBaseline = { syncedHash: hashPrompt(sys("A")), registeredVersion: 5 };
const io = (live: Live, onPush: () => void) => ({
  readBaseline: async () => baseline,
  retrieve: async () => ({ ...live }),
  detect: (l: Live) =>
    detectPromptConflict({
      liveSystem: l.system,
      liveVersion: l.version,
      syncedHash: baseline.syncedHash,
      registeredVersion: baseline.registeredVersion,
      composedSystem: sys("DB"),
    }),
  push: async () => {
    onPush();
    return 6;
  },
  isVersionConflict: () => false,
  liveHash: (l: Live) => hashPrompt(l.system),
});

test("overwrite con el hash que se mostró: empuja", async () => {
  const live = { version: 5, system: sys("EDITADO") };
  let pushes = 0;
  const r = await guardedPush(io(live, () => pushes++), {
    overwrite: true,
    initialBaseline: baseline,
    expectedLiveHash: hashPrompt(live.system),
  });
  assert.deepEqual(r, { ok: true, version: 6 });
  assert.equal(pushes, 1);
});

test("overwrite cuando el vivo cambió entre mostrar y resolver: ABORTA sin empujar y devuelve el vivo actual", async () => {
  const shown = sys("EDITADO (lo que vio el operador)");
  const live = { version: 6, system: sys("EDITADO OTRA VEZ") };
  let pushes = 0;
  const r = await guardedPush(io(live, () => pushes++), {
    overwrite: true,
    initialBaseline: baseline,
    expectedLiveHash: hashPrompt(shown),
  });
  assert.equal(pushes, 0);
  assert.ok(!r.ok && "stale" in r && r.stale === true);
  assert.equal("freshConflict" in r ? r.freshConflict?.liveHash : null, hashPrompt(live.system));
});

test("sin expectedLiveHash (sincronización normal) no se aplica la guardia", async () => {
  const live = { version: 5, system: sys("A") };
  let pushes = 0;
  const r = await guardedPush(io(live, () => pushes++), { overwrite: false, initialBaseline: baseline });
  assert.equal(r.ok, true);
  assert.equal(pushes, 1);
});

// ─── interpretación de la respuesta ───

test("409 con stale:true → kind=stale con el mensaje y el conflicto actualizado", () => {
  const o = interpretSyncResponse(409, { ok: false, stale: true, error: "cambió", conflict: { kind: "prompt_changed" } });
  assert.ok(o.kind === "stale" && o.message === "cambió" && o.conflict !== null);
});

test("409 stale sin conflicto (ya no hay nada que decidir) → conflict null", () => {
  const o = interpretSyncResponse(409, { ok: false, stale: true, error: "cambió", conflict: null });
  assert.ok(o.kind === "stale" && o.conflict === null);
});

test("409 con conflicto SIN stale sigue siendo conflict", () => {
  assert.equal(interpretSyncResponse(409, { ok: false, conflict: { kind: "prompt_changed" } }).kind, "conflict");
});
