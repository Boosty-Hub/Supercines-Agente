// _shared/draft-publish.test.ts
// La atomicidad real de la reserva la prueba supabase/tests/draft_publish_claim.sql
// contra Postgres. Acá: las decisiones puras de publish-to-kommo y el bucle, con una
// reserva en memoria que imita la semántica de claim_draft_for_publish (compare-and-set
// approved → publishing) para probar la carrera barrido de pg_cron vs. aprobación manual.

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  emptyTally,
  finalPatch,
  PUBLISH_LEASE_SECONDS,
  RELEASE_LEASE,
  resolveInterrupted,
  runPublishLoop,
  tallyOutcome,
  type DraftOutcome,
} from "./draft-publish.ts";

// ---------------- resolveInterrupted: nunca reenvía ----------------
// Eventos de Kommo con created_at en segundos epoch; la marca de envío es un timestamptz.
const SENDING_AT = "2026-10-13T12:00:00.400Z";
const AFTER = Math.floor(Date.parse(SENDING_AT) / 1000) + 3;
const BEFORE = Math.floor(Date.parse(SENDING_AT) / 1000) - 3;
const evs = (...ids: string[]) => ids.map((id) => ({ id, createdAt: AFTER }));

Deno.test("interrumpido: un saliente nuevo respecto de la foto previa y posterior a la marca → se registra enviado", () => {
  assertEquals(resolveInterrupted(["1", "2"], evs("1", "2", "3"), SENDING_AT).action, "mark_sent");
});

Deno.test("interrumpido: sin saliente nuevo → failed (revisión humana), NO reenvío", () => {
  const r = resolveInterrupted(["1", "2"], evs("2", "1"), SENDING_AT);
  assertEquals(r.action, "mark_failed");
  assert(/no se encontró/.test(r.reason));
});

Deno.test("interrumpido: sin foto previa (verificación apagada, murió entre pública y DM, o Kommo ilegible) → failed", () => {
  assertEquals(resolveInterrupted(null, evs("9"), SENDING_AT).action, "mark_failed");
});

Deno.test("interrumpido: Kommo ilegible al verificar (current null) → failed, nunca enviado en falso", () => {
  const r = resolveInterrupted([], null, SENDING_AT);
  assertEquals(r.action, "mark_failed");
  assert(/no se pudieron leer/.test(r.reason));
});

Deno.test("interrumpido: Kommo sin eventos del lead → failed", () => {
  assertEquals(resolveInterrupted([], [], SENDING_AT).action, "mark_failed");
});

Deno.test("interrumpido: un saliente que no estaba en la foto pero es ANTERIOR a la marca no es la entrega", () => {
  assertEquals(resolveInterrupted([], [{ id: "x", createdAt: BEFORE }], SENDING_AT).action, "mark_failed");
});

Deno.test("interrumpido: sin marca de envío legible → failed", () => {
  assertEquals(resolveInterrupted([], evs("x"), null).action, "mark_failed");
});

Deno.test("interrumpido: las acciones posibles son solo mark_sent / mark_failed", () => {
  const cases: Array<[string[] | null, string[] | null]> = [[null, []], [[], ["x"]], [["x"], ["x"]], [[], null]];
  for (const [b, c] of cases) {
    assert(["mark_sent", "mark_failed"].includes(resolveInterrupted(b, c && evs(...c), SENDING_AT).action));
  }
});

// ---------------- finalPatch: libera la reserva y fija el estado ----------------

const NOW = "2026-10-13T12:00:00.000Z";

Deno.test("finalPatch delivered → auto_sent con sent_at, libera el lease y limpia flags de guard previos", () => {
  const p = finalPatch({ kind: "delivered", verified: true, publicBlocked: null }, { guard_blocked: true, guard_reason: "x", foo: 1 }, NOW)!;
  assertEquals(p.status, "auto_sent");
  assertEquals(p.sent_at, NOW);
  assertEquals(p.publish_owner, null);
  assertEquals(p.publish_lease_until, null);
  assertEquals(p.agent_metadata, { foo: 1, delivery_verified: true });
});

Deno.test("finalPatch delivered recuperado → marca delivery_recovered", () => {
  const p = finalPatch({ kind: "delivered", verified: true, publicBlocked: null, recovered: true }, {}, NOW)!;
  assertEquals((p.agent_metadata as Record<string, unknown>).delivery_recovered, true);
});

Deno.test("finalPatch delivered con la pública bloqueada → guard_part=public_reply", () => {
  const p = finalPatch({ kind: "delivered", verified: false, publicBlocked: "tool_call" }, {}, NOW)!;
  const m = p.agent_metadata as Record<string, unknown>;
  assertEquals(m.guard_part, "public_reply");
  assertEquals(m.guard_reason, "tool_call");
  assertEquals(m.delivery_verified, undefined);
});

Deno.test("finalPatch: cada salida terminal libera la reserva; lease_lost no toca la fila", () => {
  const outcomes: DraftOutcome[] = [
    { kind: "delivered", verified: false, publicBlocked: null },
    { kind: "undelivered", publicBlocked: null, reason: "r" },
    { kind: "blocked_dm", reason: "r" },
    { kind: "error", message: "m" },
    { kind: "expired" },
    { kind: "released", reason: "r" },
  ];
  const expected = ["auto_sent", "failed", "pending", "failed", "rejected", "approved"];
  outcomes.forEach((o, i) => {
    const p = finalPatch(o, {}, NOW)!;
    assertEquals(p.status, expected[i], o.kind);
    for (const [k, v] of Object.entries(RELEASE_LEASE)) assertEquals(p[k], v, `${o.kind}.${k}`);
    assert(p.status !== "publishing");
  });
  assertEquals(finalPatch({ kind: "lease_lost" }, {}, NOW), null);
});

Deno.test("finalPatch blocked_dm → pending con guard_stage=publish (vuelve a revisión humana)", () => {
  const m = finalPatch({ kind: "blocked_dm", reason: "fuga" }, { x: 1 }, NOW)!.agent_metadata as Record<string, unknown>;
  assertEquals(m, { x: 1, guard_blocked: true, guard_kind: "internal_leak", guard_reason: "fuga", guard_stage: "publish" });
});

Deno.test("tallyOutcome: undelivered y blocked cuentan como failed con su error", () => {
  const t = emptyTally();
  tallyOutcome(t, "a", { kind: "undelivered", publicBlocked: null, reason: "sin entrega" });
  tallyOutcome(t, "b", { kind: "blocked_dm", reason: "fuga" });
  tallyOutcome(t, "c", { kind: "delivered", verified: true, publicBlocked: null });
  tallyOutcome(t, "d", { kind: "lease_lost" });
  assertEquals([t.published, t.undelivered, t.blocked, t.failed, t.lease_lost], [1, 1, 1, 2, 1]);
  assertEquals(t.errors.map((e) => e.draft_id), ["a", "b"]);
});

Deno.test("el lease supera el wall clock máximo de una Edge Function (400 s)", () => {
  assert(PUBLISH_LEASE_SECONDS > 400);
});

// ---------------- Bucle + carrera cron vs. manual ----------------

/** Reserva en memoria con la semántica de claim_draft_for_publish: el más viejo
 *  `approved` pasa a `publishing` en un paso indivisible (sin await en el medio). */
function memoryStore(ids: string[]) {
  const status = new Map(ids.map((id) => [id, "approved"]));
  const owner = new Map<string, string>();
  return {
    status,
    owner,
    claim(who: string): string | null {
      for (const id of ids) {
        if (status.get(id) === "approved") {
          status.set(id, "publishing");
          owner.set(id, who);
          return id;
        }
      }
      return null;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("CARRERA cron vs. manual sobre el MISMO draft: una sola reserva gana, un solo envío", async () => {
  const store = memoryStore(["d1"]);
  const sent: string[] = [];
  const worker = (who: string) =>
    runPublishLoop({
      claim: async () => {
        await tick();
        return store.claim(who);
      },
      process: async (id) => {
        assertEquals(store.owner.get(id), who, "procesa solo lo que reservó");
        await tick();
        sent.push(id);
        store.status.set(id, "auto_sent");
        return { kind: "delivered", verified: true, publicBlocked: null };
      },
    });
  const [cron, manual] = await Promise.all([worker("cron"), worker("manual")]);
  assertEquals(sent, ["d1"]);
  assertEquals(cron.published + manual.published, 1);
});

Deno.test("CARRERA con muchos drafts y tres invocaciones: cada draft se envía exactamente una vez", async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `d${i}`);
  const store = memoryStore(ids);
  const sent: string[] = [];
  const worker = (who: string) =>
    runPublishLoop({
      claim: async () => {
        await tick();
        return store.claim(who);
      },
      process: async (id) => {
        await tick();
        sent.push(id);
        return { kind: "delivered", verified: true, publicBlocked: null };
      },
      maxDrafts: 100,
    });
  const tallies = await Promise.all([worker("cron"), worker("panel"), worker("generate-response")]);
  assertEquals([...sent].sort(), [...ids].sort());
  assertEquals(new Set(sent).size, ids.length);
  assertEquals(tallies.reduce((n, t) => n + t.published, 0), ids.length);
});

Deno.test("bucle: corta por presupuesto de tiempo y deja el resto en la cola (approved)", async () => {
  const store = memoryStore(["a", "b", "c"]);
  let clock = 0;
  const t = await runPublishLoop({
    claim: async () => store.claim("w"),
    process: async () => {
      clock += 60_000;
      return { kind: "delivered", verified: true, publicBlocked: null };
    },
    now: () => clock,
    budgetMs: 100_000,
  });
  assertEquals(t.published, 2);
  assertEquals(store.status.get("c"), "approved");
});

Deno.test("bucle: el apagado total a mitad de corrida frena antes de reservar el siguiente", async () => {
  const store = memoryStore(["a", "b"]);
  let halted = false;
  const t = await runPublishLoop({
    claim: async () => store.claim("w"),
    process: async () => {
      halted = true;
      return { kind: "delivered", verified: true, publicBlocked: null };
    },
    canContinue: async () => !halted,
  });
  assertEquals(t.published, 1);
  assertEquals(store.status.get("b"), "approved");
});

Deno.test("bucle: respeta el tope por invocación", async () => {
  const store = memoryStore(["a", "b", "c"]);
  const t = await runPublishLoop({
    claim: async () => store.claim("w"),
    process: async () => ({ kind: "delivered", verified: true, publicBlocked: null }),
    maxDrafts: 2,
  });
  assertEquals(t.published, 2);
});
