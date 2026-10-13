// Tests del empuje guardado: reintento tras 409 con la línea base RELEÍDA (W3c).
// Correr con: cd web && node --test src/lib/guarded-push.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardedPush, type PushBaseline } from "./guarded-push.ts";
import { detectPromptConflict, hashPrompt } from "./agent-prompt-sync.ts";

const sc = "---\n\n## Flujo obligatorio antes de redactar\n\nX\n";
const sys = (op: string) => `${op}\n\n${sc}`;
const e409 = new Error("Anthropic POST /v1/agents/x → 409: conflict");
const isVersionConflict = (e: unknown) => e === e409;

const detector = (composed: string) => (l: { version: number; system: string }, b: PushBaseline) =>
  detectPromptConflict({
    liveSystem: l.system,
    liveVersion: l.version,
    syncedHash: b.syncedHash,
    registeredVersion: b.registeredVersion,
    composedSystem: composed,
  });

test("409 porque otro sync se adelantó: el reintento relee la línea base y NO da falso conflicto", async () => {
  // Sincronizado con "A" en v5. Otro proceso sincroniza "B" (v6) mientras tanto.
  let live = { version: 5, system: sys("A") };
  let db: PushBaseline = { syncedHash: hashPrompt(sys("A")), registeredVersion: 5 };
  const initial = { ...db };
  let pushes = 0;

  const r = await guardedPush(
    {
      readBaseline: async () => db,
      retrieve: async () => ({ ...live }),
      detect: detector(sys("C")),
      push: async (version) => {
        pushes++;
        if (pushes === 1) {
          // la escritura concurrente gana: sube el agente y registra su hash/versión
          live = { version: 6, system: sys("B") };
          db = { syncedHash: hashPrompt(sys("B")), registeredVersion: 6 };
          throw e409;
        }
        assert.equal(version, 6);
        return 7;
      },
      isVersionConflict,
    },
    { overwrite: false, initialBaseline: initial },
  );
  assert.deepEqual(r, { ok: true, version: 7 });
  assert.equal(pushes, 2);
});

test("el mismo escenario con la línea base CAPTURADA (bug previo) daba falso conflicto", () => {
  const stale: PushBaseline = { syncedHash: hashPrompt(sys("A")), registeredVersion: 5 };
  const c = detector(sys("C"))({ version: 6, system: sys("B") }, stale);
  assert.equal(c?.kind, "prompt_changed");
});

test("409 y, tras releer, el vivo SÍ fue editado por un tercero: conflicto real", async () => {
  let pushes = 0;
  let live = { version: 5, system: sys("A") };
  const db: PushBaseline = { syncedHash: hashPrompt(sys("A")), registeredVersion: 5 };
  const r = await guardedPush(
    {
      readBaseline: async () => db, // nadie registró nada: la edición fue externa
      retrieve: async () => ({ ...live }),
      detect: detector(sys("C")),
      push: async () => {
        pushes++;
        live = { version: 6, system: sys("EDITADO A MANO") };
        throw e409;
      },
      isVersionConflict,
    },
    { overwrite: false, initialBaseline: db },
  );
  assert.equal(r.ok, false);
  assert.ok("conflict" in r && r.conflict.kind === "prompt_changed");
  assert.equal(pushes, 1);
});

test("overwrite no consulta conflictos; un error que no es 409 no reintenta", async () => {
  let detects = 0;
  const base: PushBaseline = { syncedHash: "x", registeredVersion: 1 };
  const ok = await guardedPush(
    {
      readBaseline: async () => base,
      retrieve: async () => ({ version: 1 }),
      detect: () => {
        detects++;
        return null;
      },
      push: async () => 2,
      isVersionConflict,
    },
    { overwrite: true, initialBaseline: base },
  );
  assert.deepEqual(ok, { ok: true, version: 2 });
  assert.equal(detects, 0);

  let calls = 0;
  const bad = await guardedPush(
    {
      readBaseline: async () => base,
      retrieve: async () => ({ version: 1 }),
      detect: () => null,
      push: async () => {
        calls++;
        throw new Error("500");
      },
      isVersionConflict,
    },
    { overwrite: false, initialBaseline: base },
  );
  assert.deepEqual(bad, { ok: false, error: "500" });
  assert.equal(calls, 1);
});
