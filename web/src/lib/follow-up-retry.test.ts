// Reintento por intento (0077). Correr con: cd web && node --test src/lib/follow-up-retry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { latestAttemptIds, parseRetryBody, timestampMicros, type AttemptRow } from "./follow-up-retry.ts";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";
const D = "dddddddd-0000-0000-0000-000000000004";

test("parseRetryBody: exige followUpId (uuid) y step entero ≥ 1", () => {
  assert.deepEqual(parseRetryBody({ followUpId: A, step: 2 }), {
    ok: true,
    value: { followUpId: A, step: 2, force: false, confirmResend: false },
  });
  for (const b of [
    null,
    [],
    {},
    { leadId: A },
    { followUpId: "x", step: 1 },
    { followUpId: A },
    { followUpId: A, step: 0 },
    { followUpId: A, step: "2" },
    { followUpId: A, step: 1.5 },
  ]) {
    assert.equal(parseRetryBody(b).ok, false, JSON.stringify(b));
  }
});

test("parseRetryBody: force/confirmResend solo con true literal", () => {
  const r = parseRetryBody({ followUpId: A, step: 1, force: "true", confirmResend: true });
  assert.ok(r.ok);
  assert.equal(r.value.force, false);
  assert.equal(r.value.confirmResend, true);
});

test("parseRetryBody: una clave heredada (__proto__/constructor) no cuenta como campo", () => {
  const body = JSON.parse(`{"__proto__": {"followUpId": "${A}", "step": 1}}`);
  assert.equal(parseRetryBody(body).ok, false);
});

test("latestAttemptIds: solo el último intento de cada (lead, paso)", () => {
  const rows: AttemptRow[] = [
    { id: C, leadId: "L1", step: 2, sentAt: "2026-10-13T12:05:00Z" },
    { id: B, leadId: "L1", step: 2, sentAt: "2026-10-13T12:00:00Z" },
    { id: A, leadId: "L1", step: 1, sentAt: "2026-10-12T12:00:00Z" },
    { id: D, leadId: "L2", step: 2, sentAt: "2026-10-13T11:00:00Z" },
  ];
  assert.deepEqual(latestAttemptIds(rows), new Set([C, A, D]));
});

test("latestAttemptIds: empate de sent_at → gana el id mayor (mismo desempate que la base)", () => {
  const t = "2026-10-13T12:00:00.123Z";
  const rows: AttemptRow[] = [
    { id: A, leadId: "L1", step: 1, sentAt: t },
    { id: B, leadId: "L1", step: 1, sentAt: t },
  ];
  assert.deepEqual(latestAttemptIds(rows), new Set([B]));
});

test("latestAttemptIds: dos intentos en el MISMO milisegundo se ordenan por microsegundos (no por id)", () => {
  // B tiene id mayor pero es 1 µs más viejo: la base (sent_at desc) dice que el último es A.
  const rows: AttemptRow[] = [
    { id: B, leadId: "L1", step: 1, sentAt: "2026-10-13T12:00:00.123455+00:00" },
    { id: A, leadId: "L1", step: 1, sentAt: "2026-10-13T12:00:00.123456+00:00" },
  ];
  assert.deepEqual(latestAttemptIds(rows), new Set([A]));
  assert.deepEqual(latestAttemptIds([...rows].reverse()), new Set([A]));
});

test("latestAttemptIds: fracciones de largo distinto y offsets distintos comparan por el instante real", () => {
  const rows: AttemptRow[] = [
    { id: B, leadId: "L1", step: 1, sentAt: "2026-10-13T12:00:00.1+00:00" }, // .100000
    { id: A, leadId: "L1", step: 1, sentAt: "2026-10-13T09:00:00.100001-03:00" }, // 12:00:00.100001Z
  ];
  assert.deepEqual(latestAttemptIds(rows), new Set([A]));
});

test("timestampMicros: precisión de microsegundos y formatos de PostgREST", () => {
  assert.equal(timestampMicros("1970-01-01T00:00:00Z"), BigInt(0));
  assert.equal(timestampMicros("1970-01-01T00:00:00.000001+00:00"), BigInt(1));
  assert.equal(timestampMicros("1970-01-01 00:00:01.5+00"), BigInt(1_500_000));
  assert.equal(timestampMicros("1970-01-01T01:00:00+0100"), BigInt(0));
  assert.equal(
    timestampMicros("2026-10-13T12:00:00.123456+00:00")! - timestampMicros("2026-10-13T12:00:00.123455Z")!,
    BigInt(1)
  );
  assert.equal(timestampMicros("no es fecha"), null);
});

test("latestAttemptIds: un sent_at ilegible nunca le gana a uno válido", () => {
  const rows: AttemptRow[] = [
    { id: B, leadId: "L1", step: 1, sentAt: "basura" },
    { id: A, leadId: "L1", step: 1, sentAt: "2026-10-13T12:00:00Z" },
  ];
  assert.deepEqual(latestAttemptIds(rows), new Set([A]));
});

test("latestAttemptIds: el orden de entrada no importa", () => {
  const rows: AttemptRow[] = [
    { id: B, leadId: "L1", step: 2, sentAt: "2026-10-13T12:00:00Z" },
    { id: C, leadId: "L1", step: 2, sentAt: "2026-10-13T12:05:00Z" },
  ];
  assert.deepEqual(latestAttemptIds(rows), new Set([C]));
});
