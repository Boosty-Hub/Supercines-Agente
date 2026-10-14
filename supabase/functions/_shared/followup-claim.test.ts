// _shared/followup-claim.test.ts
// Decisiones puras del envío de seguimientos con reserva (0072). La atomicidad de la
// reserva se prueba contra Postgres en supabase/tests/follow_up_claim.sql.
// Correr con: deno test --allow-read supabase/functions/_shared/followup-claim.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  CLAIM_MESSAGES,
  closeFor,
  FOLLOW_UP_LEASE_SECONDS,
  interpretClaim,
  outcomeAfterError,
  resolveDeadFollowUp,
  runClaimedFollowUp,
  type ClaimClose,
  type ClaimResult,
  type FollowUpOutcome,
} from "./followup-claim.ts";

const ID = "11111111-1111-1111-1111-111111111111";
// Marca de envío y eventos de Kommo (created_at en segundos epoch).
const SENDING_AT = "2026-10-13T12:00:00.400Z";
const SENDING_S = Date.parse(SENDING_AT) / 1000;
const BEFORE = Math.floor(SENDING_S) - 5;
const SAME_SECOND = Math.floor(SENDING_S);
const AFTER = Math.floor(SENDING_S) + 3;
const ev = (id: string, createdAt: number) => ({ id, createdAt });

// ─── interpretClaim ───────────────────────────────────────────────────────

Deno.test("interpretClaim: fila claimed con id → ok", () => {
  assertEquals(interpretClaim([{ follow_up_id: ID, reason: "claimed" }], null), { ok: true, id: ID });
});

Deno.test("interpretClaim: cada motivo de rechazo trae su mensaje para el operador", () => {
  for (const reason of Object.keys(CLAIM_MESSAGES) as Array<keyof typeof CLAIM_MESSAGES>) {
    assertEquals(interpretClaim([{ follow_up_id: null, reason }], null), {
      ok: false,
      reason,
      message: CLAIM_MESSAGES[reason],
    });
  }
});

Deno.test("interpretClaim: error de la RPC → no reservado (nunca se envía sin reserva)", () => {
  const r = interpretClaim(null, { message: "permission denied" });
  assertEquals(r.ok, false);
  assertEquals(r.ok ? null : r.reason, "error");
});

Deno.test("interpretClaim: respuesta rara (claimed sin id, vacío, motivo desconocido) → error", () => {
  for (const data of [[{ follow_up_id: null, reason: "claimed" }], [], null, [{ follow_up_id: ID, reason: "x" }]]) {
    const r = interpretClaim(data, null);
    assertEquals(r.ok ? null : r.reason, "error");
  }
});

Deno.test("interpretClaim: un motivo que coincide con algo heredado (constructor, __proto__…) → error, no un mensaje heredado", () => {
  for (const reason of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    const r = interpretClaim([{ follow_up_id: null, reason }], null);
    assertEquals(r.ok ? null : r.reason, "error", reason);
    assertEquals(!r.ok && typeof r.message, "string", reason);
    assertEquals(!r.ok && r.message.startsWith("claim_follow_up: respuesta inesperada"), true, reason);
  }
});

// ─── closeFor ─────────────────────────────────────────────────────────────

Deno.test("closeFor: enviado → finish sent con las variables", () => {
  assertEquals(closeFor({ kind: "sent", variables: { n: "Ana" } }), {
    rpc: "finish_follow_up",
    status: "sent",
    error: null,
    variables: { n: "Ana" },
  });
});

Deno.test("closeFor: recuperado → finish sent con la nota y sin pisar las variables guardadas al marcar", () => {
  const c = closeFor({ kind: "sent", recovered: true });
  assertEquals(c?.rpc, "finish_follow_up");
  if (c?.rpc === "finish_follow_up") {
    assertEquals(c.status, "sent");
    assertEquals(c.variables, null);
    assertEquals(typeof c.error, "string");
  }
});

Deno.test("closeFor: failed y unconfirmed → finish failed (la marca distingue «sin confirmar» en la base)", () => {
  assertEquals(closeFor({ kind: "failed", error: "e" }), { rpc: "finish_follow_up", status: "failed", error: "e", variables: null });
  assertEquals(closeFor({ kind: "unconfirmed", error: "u" }), { rpc: "finish_follow_up", status: "failed", error: "u", variables: null });
});

Deno.test("closeFor: released → release; lease_lost → no tocar", () => {
  assertEquals(closeFor({ kind: "released", reason: "skip" }), { rpc: "release_follow_up_claim" });
  assertEquals(closeFor({ kind: "lease_lost" }), null);
});

// ─── outcomeAfterError / resolveDeadFollowUp ──────────────────────────────

Deno.test("error antes de la marca → failed (no salió nada; se reintenta)", () => {
  assertEquals(outcomeAfterError("Kommo 500", false), { kind: "failed", error: "Kommo 500" });
});

Deno.test("error después de la marca → unconfirmed (nunca failed reintentable)", () => {
  const o = outcomeAfterError("timeout", true);
  assertEquals(o.kind, "unconfirmed");
});

Deno.test("reserva muerta con marca: saliente nuevo respecto de la foto → sent recuperado", () => {
  assertEquals(resolveDeadFollowUp(["e1"], [ev("e1", AFTER), ev("e2", AFTER)], SENDING_AT), {
    kind: "sent",
    recovered: true,
  });
});

Deno.test("reserva muerta con marca: sin saliente nuevo o sin foto → unconfirmed, NUNCA reenviar", () => {
  assertEquals(resolveDeadFollowUp(["e1"], [ev("e1", AFTER)], SENDING_AT).kind, "unconfirmed");
  assertEquals(resolveDeadFollowUp(null, [ev("e9", AFTER)], SENDING_AT).kind, "unconfirmed");
});

Deno.test("reserva muerta con marca: Kommo ilegible ahora (current null) → unconfirmed", () => {
  assertEquals(resolveDeadFollowUp(["e1"], null, SENDING_AT).kind, "unconfirmed");
});

Deno.test("reserva muerta con marca: un saliente nuevo ANTERIOR (o del mismo segundo) a la marca no confirma", () => {
  assertEquals(resolveDeadFollowUp([], [ev("e2", BEFORE)], SENDING_AT).kind, "unconfirmed");
  assertEquals(resolveDeadFollowUp([], [ev("e2", SAME_SECOND)], SENDING_AT).kind, "unconfirmed");
  assertEquals(resolveDeadFollowUp([], [{ id: "e2", createdAt: null }], SENDING_AT).kind, "unconfirmed");
});

Deno.test("reserva muerta con marca: sin marca legible → unconfirmed", () => {
  assertEquals(resolveDeadFollowUp([], [ev("e2", AFTER)], null).kind, "unconfirmed");
  assertEquals(resolveDeadFollowUp([], [ev("e2", AFTER)], "no es una fecha").kind, "unconfirmed");
});

Deno.test("el lease supera el wall clock de una Edge Function (400 s)", () => {
  assertEquals(FOLLOW_UP_LEASE_SECONDS > 400, true);
});

// ─── runClaimedFollowUp ───────────────────────────────────────────────────

function harness(opts: {
  claim?: ClaimResult;
  markOk?: boolean;
  work: (mark: (b: string[] | null, v: Record<string, string>) => Promise<void>) => Promise<FollowUpOutcome>;
  closeThrows?: boolean;
}) {
  const calls = { work: 0, marks: 0, closes: [] as Array<Exclude<ClaimClose, null>> };
  const run = runClaimedFollowUp({
    claim: () => Promise.resolve(opts.claim ?? { ok: true, id: ID }),
    mark: () => {
      calls.marks++;
      return Promise.resolve(opts.markOk ?? true);
    },
    work: (m) => {
      calls.work++;
      return opts.work(m);
    },
    close: (_id, c) => {
      calls.closes.push(c);
      return opts.closeThrows ? Promise.reject(new Error("red")) : Promise.resolve();
    },
  });
  return { run, calls };
}

Deno.test("sin reserva no hay trabajo ni cierre (el reintento concurrente no envía)", async () => {
  const { run, calls } = harness({
    claim: { ok: false, reason: "in_flight", message: CLAIM_MESSAGES.in_flight },
    work: () => Promise.resolve({ kind: "sent" }),
  });
  assertEquals(await run, { kind: "refused", reason: "in_flight", message: CLAIM_MESSAGES.in_flight });
  assertEquals(calls.work, 0);
  assertEquals(calls.closes.length, 0);
});

Deno.test("envío normal: marca y cierra sent", async () => {
  const { run, calls } = harness({
    work: async (mark) => {
      await mark(["e1"], { n: "Ana" });
      return { kind: "sent", variables: { n: "Ana" } };
    },
  });
  assertEquals((await run).kind, "sent");
  assertEquals(calls.marks, 1);
  assertEquals(calls.closes[0], { rpc: "finish_follow_up", status: "sent", error: null, variables: { n: "Ana" } });
});

Deno.test("la marca falla (lease vencido) → lease_lost: el trabajo NO sigue hacia el salesbot y no se cierra nada", async () => {
  let salesbot = false;
  const { run, calls } = harness({
    markOk: false,
    work: async (mark) => {
      await mark(null, {});
      salesbot = true;
      return { kind: "sent" };
    },
  });
  assertEquals(await run, { kind: "lease_lost" });
  assertEquals(salesbot, false);
  assertEquals(calls.closes.length, 0);
});

Deno.test("excepción ANTES de la marca → failed (reintentable)", async () => {
  const { run, calls } = harness({ work: () => Promise.reject(new Error("CMA caído")) });
  assertEquals(await run, { kind: "failed", error: "CMA caído" });
  assertEquals(calls.closes[0], { rpc: "finish_follow_up", status: "failed", error: "CMA caído", variables: null });
});

Deno.test("excepción DESPUÉS de la marca → unconfirmed, nunca failed reintentable", async () => {
  const { run } = harness({
    work: async (mark) => {
      await mark(null, {});
      throw new Error("salesbot 502");
    },
  });
  assertEquals((await run).kind, "unconfirmed");
});

Deno.test("invariante: failed o released devueltos tras marcar se cierran como unconfirmed", async () => {
  for (const after of [{ kind: "failed", error: "x" }, { kind: "released", reason: "y" }] as FollowUpOutcome[]) {
    const { run, calls } = harness({
      work: async (mark) => {
        await mark(null, {});
        return after;
      },
    });
    assertEquals((await run).kind, "unconfirmed");
    assertEquals(calls.closes[0].rpc, "finish_follow_up");
  }
});

Deno.test("released sin marca → release (no queda rastro de un intento que no hubo)", async () => {
  const { run, calls } = harness({ work: () => Promise.resolve({ kind: "released", reason: "skip" }) });
  assertEquals(await run, { kind: "released", reason: "skip" });
  assertEquals(calls.closes, [{ rpc: "release_follow_up_claim" }]);
});

Deno.test("si el cierre falla, no lanza: lo resuelve la recuperación al vencer el lease", async () => {
  const { run } = harness({ closeThrows: true, work: () => Promise.resolve({ kind: "sent" }) });
  assertEquals((await run).kind, "sent");
});
