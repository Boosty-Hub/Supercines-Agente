// Tests de la cola de movimientos por lead y de la comparación de posición esperada.
// Correr con: cd web && node --test src/lib/move-queue.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUSY_RETRY_DELAYS_MS, DEFERRED_MESSAGE, interpretMoveResponse, MoveQueue, type Dest, type Position, type SendResult } from "./move-queue.ts";
import { parseExpected } from "./move-position.ts";

type Call = { leadId: string; dest: Dest; expected: Position; resolve: (r: SendResult) => void };

/** Send controlable: cada envío queda pendiente hasta que el test lo resuelve. */
function harness() {
  const calls: Call[] = [];
  // Esperas controlables: cada sleep queda pendiente hasta que el test lo suelta.
  const sleeps: Array<{ ms: number; release: () => void }> = [];
  const q = new MoveQueue(
    (leadId, dest, expected) => new Promise<SendResult>((resolve) => calls.push({ leadId, dest, expected, resolve })),
    { sleep: (ms) => new Promise<void>((release) => sleeps.push({ ms, release })) }
  );
  return { q, calls, sleeps };
}
const tick = () => new Promise((r) => setImmediate(r));
const P = (pipeline: number | null, stage: number | null): Position => ({ pipeline, stage });
const D = (pipeline: number, stage: number): Dest => ({ pipeline, stage });

test("SERIALIZA: el segundo envío del mismo lead no sale hasta que el primero termina", async () => {
  const { q, calls } = harness();
  const a = q.enqueue("l1", D(1, 20), P(1, 10));
  await tick();
  const b = q.enqueue("l1", D(1, 30), P(1, 20)); // el llamador ya ve el optimista
  await tick();
  assert.equal(calls.length, 1, "solo el primero está en vuelo");
  calls[0].resolve({ kind: "ok" });
  assert.deepEqual(await a, { kind: "done", warning: undefined });
  await tick();
  assert.equal(calls.length, 2);
  // el segundo parte de la posición CONFIRMADA por el primero, no de la optimista
  assert.deepEqual(calls[1].expected, P(1, 20));
  assert.deepEqual(calls[1].dest, D(1, 30));
  calls[1].resolve({ kind: "ok" });
  assert.equal((await b).kind, "done");
  assert.equal(q.isBusy("l1"), false);
});

test("COALESCE: gana el ÚLTIMO destino; los intermedios se reemplazan sin enviarse", async () => {
  const { q, calls } = harness();
  const a = q.enqueue("l1", D(1, 20), P(1, 10));
  await tick();
  const b = q.enqueue("l1", D(1, 30), P(1, 10));
  const c = q.enqueue("l1", D(1, 40), P(1, 10));
  assert.deepEqual(await b, { kind: "superseded" });
  calls[0].resolve({ kind: "ok" });
  await a;
  await tick();
  assert.equal(calls.length, 2, "B nunca se envió");
  assert.deepEqual(calls[1].dest, D(1, 40));
  calls[1].resolve({ kind: "ok" });
  assert.equal((await c).kind, "done");
});

test("volver al origen mientras el primero está en vuelo: nada que enviar tras confirmar", async () => {
  const { q, calls } = harness();
  const a = q.enqueue("l1", D(1, 20), P(1, 10));
  await tick();
  const b = q.enqueue("l1", D(1, 20), P(1, 10)); // mismo destino que lo confirmado al terminar A
  calls[0].resolve({ kind: "ok" });
  await a;
  assert.deepEqual(await b, { kind: "noop" });
  assert.equal(calls.length, 1);
});

test("ESTADO OPTIMISTA: si falla el último, revertTo es la última posición confirmada", async () => {
  const { q, calls } = harness();
  const a = q.enqueue("l1", D(1, 20), P(1, 10));
  await tick();
  calls[0].resolve({ kind: "ok" });
  await a;
  const b = q.enqueue("l1", D(1, 30), P(1, 20));
  await tick();
  calls[1].resolve({ kind: "error", message: "Kommo no respondió" });
  assert.deepEqual(await b, { kind: "failed", message: "Kommo no respondió", revertTo: P(1, 20) });
});

test("si falla el primero y hay uno más nuevo en cola, NO revierte (revertTo null) y el nuevo parte del origen", async () => {
  const { q, calls } = harness();
  const a = q.enqueue("l1", D(1, 20), P(1, 10));
  await tick();
  const b = q.enqueue("l1", D(1, 30), P(1, 10));
  calls[0].resolve({ kind: "error", message: "429" });
  assert.deepEqual(await a, { kind: "failed", message: "429", revertTo: null });
  await tick();
  assert.deepEqual(calls[1].expected, P(1, 10), "el primero falló: la posición confirmada sigue siendo el origen");
  calls[1].resolve({ kind: "ok" });
  assert.equal((await b).kind, "done");
});

test("409: adopta la posición real y reencola UNA vez", async () => {
  const { q, calls } = harness();
  const a = q.enqueue("l1", D(1, 30), P(1, 10));
  await tick();
  calls[0].resolve({ kind: "conflict", current: P(1, 25) }); // alguien lo movió en Kommo
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].expected, P(1, 25));
  calls[1].resolve({ kind: "ok" });
  assert.equal((await a).kind, "done");
});

test("409 repetido: se rinde con error y revierte a la posición real (sin bucle)", async () => {
  const { q, calls } = harness();
  const a = q.enqueue("l1", D(1, 30), P(1, 10));
  await tick();
  calls[0].resolve({ kind: "conflict", current: P(1, 25) });
  await tick();
  calls[1].resolve({ kind: "conflict", current: P(1, 26) });
  const out = await a;
  assert.equal(out.kind, "failed");
  assert.deepEqual(out.kind === "failed" && out.revertTo, P(1, 26));
  assert.equal(calls.length, 2);
});

test("409 donde la posición real ya es el destino: noop, sin segundo envío", async () => {
  const { q, calls } = harness();
  const a = q.enqueue("l1", D(1, 30), P(1, 10));
  await tick();
  calls[0].resolve({ kind: "conflict", current: P(1, 30) });
  assert.deepEqual(await a, { kind: "noop" });
  assert.equal(calls.length, 1);
});

test("leads distintos NO se bloquean entre sí", async () => {
  const { q, calls } = harness();
  void q.enqueue("l1", D(1, 20), P(1, 10));
  void q.enqueue("l2", D(1, 20), P(1, 10));
  await tick();
  assert.equal(calls.length, 2);
});

test("un send que lanza se trata como fallo y libera la cola", async () => {
  const q = new MoveQueue(async () => {
    throw new Error("boom");
  });
  const out = await q.enqueue("l1", D(1, 20), P(1, 10));
  assert.deepEqual(out, { kind: "failed", message: "boom", revertTo: P(1, 10) });
  assert.equal(q.isBusy("l1"), false);
});

test("servidor: parseExpected", () => {
  assert.equal(parseExpected(undefined), undefined);
  assert.equal(parseExpected("x"), null);
  assert.equal(parseExpected({ pipeline_id: 1 }), null);
  assert.deepEqual(parseExpected({ pipeline_id: null, stage_id: 5 }), { pipeline_id: null, stage_id: 5 });
});

// ── 409 move_in_progress (otro movimiento del mismo lead en vuelo: otra pestaña/persona) ──

test("OCUPADO: reintenta tras una espera corta y, si se libera, el movimiento sale", async () => {
  const { q, calls, sleeps } = harness();
  const a = q.enqueue("l1", D(1, 30), P(1, 10));
  await tick();
  calls[0].resolve({ kind: "busy" });
  await tick();
  assert.equal(sleeps.length, 1, "espera antes de reintentar");
  assert.equal(sleeps[0].ms, BUSY_RETRY_DELAYS_MS[0]);
  assert.equal(calls.length, 1, "no reintenta antes de la espera");
  sleeps[0].release();
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].expected, P(1, 10));
  calls[1].resolve({ kind: "ok" });
  assert.equal((await a).kind, "done");
});

test("OCUPADO y el otro movimiento ganó: el reintento choca con la posición nueva, la adopta y reencola", async () => {
  const { q, calls, sleeps } = harness();
  const a = q.enqueue("l1", D(1, 30), P(1, 10));
  await tick();
  calls[0].resolve({ kind: "busy" });
  await tick();
  sleeps[0].release();
  await tick();
  calls[1].resolve({ kind: "conflict", current: P(1, 20) }); // la otra pestaña lo dejó en 20
  await tick();
  assert.deepEqual(calls[2].expected, P(1, 20));
  calls[2].resolve({ kind: "ok" });
  assert.equal((await a).kind, "done");
});

test("OCUPADO persistente: tras los reintentos con backoff, aviso NEUTRO (deferred) y NUNCA failed/revert", async () => {
  const { q, calls, sleeps } = harness();
  const a = q.enqueue("l1", D(1, 30), P(1, 10));
  for (let i = 0; i <= BUSY_RETRY_DELAYS_MS.length; i++) {
    await tick();
    calls[i].resolve({ kind: "busy" });
    await tick();
    if (i < BUSY_RETRY_DELAYS_MS.length) sleeps[i].release();
  }
  const out = await a;
  assert.deepEqual(out, { kind: "deferred", message: DEFERRED_MESSAGE });
  assert.equal(calls.length, 1 + BUSY_RETRY_DELAYS_MS.length, "1 envío + los reintentos, sin bucle");
  assert.deepEqual(
    sleeps.map((x) => x.ms),
    [...BUSY_RETRY_DELAYS_MS],
    "backoff creciente"
  );
  assert.ok(BUSY_RETRY_DELAYS_MS[1] > BUSY_RETRY_DELAYS_MS[0]);
  assert.equal(q.isBusy("l1"), false, "libera la cola");
});

test("OCUPADO y llega un destino más nuevo durante la espera: el viejo queda superseded y sale el nuevo", async () => {
  const { q, calls, sleeps } = harness();
  const a = q.enqueue("l1", D(1, 30), P(1, 10));
  await tick();
  calls[0].resolve({ kind: "busy" });
  await tick();
  const b = q.enqueue("l1", D(1, 40), P(1, 30));
  sleeps[0].release();
  assert.deepEqual(await a, { kind: "superseded" }, "al terminar la espera, el viejo cede sin reintentar");
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].dest, D(1, 40));
  assert.deepEqual(calls[1].expected, P(1, 10), "parte de la posición confirmada, no de la optimista");
  calls[1].resolve({ kind: "ok" });
  assert.equal((await b).kind, "done");
});

test("interpretMoveResponse: 409 move_in_progress es busy (NO error que revierta la tarjeta)", () => {
  assert.deepEqual(interpretMoveResponse(409, { code: "move_in_progress", error: "Ya hay un movimiento…" }), { kind: "busy" });
  assert.deepEqual(interpretMoveResponse(409, { code: "position_changed", current: { pipeline_id: 1, stage_id: 25 } }), {
    kind: "conflict",
    current: P(1, 25),
  });
  assert.deepEqual(interpretMoveResponse(409, { error: "El lead no está vinculado a Kommo." }), {
    kind: "error",
    message: "El lead no está vinculado a Kommo.",
  });
  assert.deepEqual(interpretMoveResponse(502, null), { kind: "error", message: "HTTP 502" });
  assert.deepEqual(interpretMoveResponse(200, { ok: true, warning: "w" }), { kind: "ok", warning: "w" });
});
