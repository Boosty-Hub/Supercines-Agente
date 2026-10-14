// _shared/followup-retry.test.ts
// Deno test para gate() / retryOutcomeFor().
// Correr con: deno test --allow-read supabase/functions/_shared/followup-retry.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  evaluateRetryGate,
  parseScanRequest,
  retryOutcomeFor,
  type RetryAttemptRow,
  type RetryConfigRow,
  type RetryLeadRow,
} from "./followup-retry.ts";
import { CLAIM_MESSAGES } from "./followup-claim.ts";

const okLead: RetryLeadRow = {
  follow_up_step: 1,
  follow_up_status: "active",
  opted_out: false,
  kommo_lead_id: 555,
};

const okCfg: RetryConfigRow = { enabled: true, max_follow_ups: 3 };

const ATTEMPT_ID = "22222222-2222-2222-2222-222222222222";
const LEAD_ID = "33333333-3333-3333-3333-333333333333";

/** El caso de siempre: la persona reintenta el intento fallido del paso que le toca al lead. */
function gate(lead: RetryLeadRow | null, cfg: RetryConfigRow | null) {
  const step = Number(lead?.follow_up_step ?? 0) + 1;
  const attempt: RetryAttemptRow = { id: ATTEMPT_ID, lead_id: LEAD_ID, step, status: "failed" };
  return evaluateRetryGate(step, attempt, lead, cfg);
}

// ─── evaluateRetryGate ────────────────────────────────────────────────────

Deno.test("lead que no existe → bloqueado, motivo legible", () => {
  const r = gate(null, okCfg);
  assertEquals(r, { ok: false, reason: "el lead no existe" });
});

Deno.test("lead opted_out → bloqueado ANTES de mirar la config (opt-out es el freno más duro)", () => {
  const r = gate({ ...okLead, opted_out: true }, null);
  assertEquals(r, { ok: false, reason: "el lead pidió no recibir más mensajes (opt-out)" });
});

for (const status of ["responded", "stopped", "exhausted"]) {
  Deno.test(`estado terminal "${status}" → bloqueado con el estado en el motivo`, () => {
    const r = gate({ ...okLead, follow_up_status: status }, okCfg);
    assertEquals(r, { ok: false, reason: `el seguimiento de este lead está en estado "${status}"` });
  });
}

Deno.test("estado no terminal (ej. active o null) → no lo bloquea por estado", () => {
  const r1 = gate({ ...okLead, follow_up_status: "active" }, okCfg);
  const r2 = gate({ ...okLead, follow_up_status: null }, okCfg);
  assertEquals(r1.ok, true);
  assertEquals(r2.ok, true);
});

Deno.test("sin kommo_lead_id → bloqueado, no se puede enviar", () => {
  const r = gate({ ...okLead, kommo_lead_id: null }, okCfg);
  assertEquals(r, { ok: false, reason: "el lead no tiene kommo_lead_id — no se puede enviar" });
});

Deno.test("config ausente → bloqueado (seguimiento apagado)", () => {
  const r = gate(okLead, null);
  assertEquals(r, { ok: false, reason: "el seguimiento está apagado en la configuración" });
});

Deno.test("config con enabled=false → bloqueado", () => {
  const r = gate(okLead, { enabled: false, max_follow_ups: 3 });
  assertEquals(r, { ok: false, reason: "el seguimiento está apagado en la configuración" });
});

Deno.test("follow_up_step + 1 ya supera max_follow_ups → bloqueado con el tope en el motivo", () => {
  const r = gate({ ...okLead, follow_up_step: 3 }, { enabled: true, max_follow_ups: 3 });
  assertEquals(r, { ok: false, reason: "ya alcanzó el máximo de 3 seguimientos" });
});

Deno.test("follow_up_step + 1 == max_follow_ups (el último posible) → permitido", () => {
  const r = gate({ ...okLead, follow_up_step: 2 }, { enabled: true, max_follow_ups: 3 });
  assertEquals(r, { ok: true, step: 3, maxFollowUps: 3 });
});

Deno.test("lead nunca contactado (follow_up_step null) → reintenta el paso 1", () => {
  const r = gate({ ...okLead, follow_up_step: null }, okCfg);
  assertEquals(r, { ok: true, step: 1, maxFollowUps: 3 });
});

Deno.test("max_follow_ups ausente en config → default 3 (mismo default que el resto del módulo)", () => {
  const r = gate({ ...okLead, follow_up_step: 2 }, { enabled: true, max_follow_ups: null });
  assertEquals(r, { ok: true, step: 3, maxFollowUps: 3 });
});

Deno.test("caso feliz completo → ok con el próximo paso y el tope", () => {
  const r = gate(okLead, okCfg);
  assertEquals(r, { ok: true, step: 2, maxFollowUps: 3 });
});

// ─── reintento POR INTENTO (W1) ───────────────────────────────────────────

const failedStep2: RetryAttemptRow = { id: ATTEMPT_ID, lead_id: LEAD_ID, step: 2, status: "failed" };

Deno.test("intento inexistente → conflicto (fila vieja), no un envío", () => {
  const r = evaluateRetryGate(2, null, okLead, okCfg);
  assertEquals(r.ok, false);
  assertEquals(!r.ok && r.conflict, true);
});

Deno.test("el paso pedido no es el del intento → conflicto", () => {
  const r = evaluateRetryGate(3, failedStep2, okLead, okCfg);
  assertEquals(!r.ok && r.conflict, true);
});

Deno.test("el intento no quedó fallido (enviado o en curso) → conflicto", () => {
  for (const status of ["sent", "claimed", "duplicate"]) {
    const r = evaluateRetryGate(2, { ...failedStep2, status }, okLead, okCfg);
    assertEquals(!r.ok && r.conflict, true, status);
  }
});

Deno.test("el lead ya avanzó (el paso del intento no es follow_up_step + 1) → conflicto con el paso actual", () => {
  const r = evaluateRetryGate(2, failedStep2, { ...okLead, follow_up_step: 2 }, okCfg);
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.conflict, true);
    assertEquals(/el siguiente es el 3/.test(r.reason), true);
  }
});

Deno.test("un paso anterior al que le toca (fila de un paso ya superado) → conflicto", () => {
  const r = evaluateRetryGate(1, { ...failedStep2, step: 1 }, okLead, okCfg);
  assertEquals(!r.ok && r.conflict, true);
});

Deno.test("el intento del paso que le toca → ok", () => {
  assertEquals(evaluateRetryGate(2, failedStep2, okLead, okCfg), { ok: true, step: 2, maxFollowUps: 3 });
});

Deno.test("los gates que protegen al cliente NO son conflicto (opt-out, terminal, apagado)", () => {
  const optOut = evaluateRetryGate(2, failedStep2, { ...okLead, opted_out: true }, okCfg);
  const off = evaluateRetryGate(2, failedStep2, okLead, { enabled: false, max_follow_ups: 3 });
  assertEquals(!optOut.ok && optOut.conflict, undefined);
  assertEquals(!off.ok && off.conflict, undefined);
});

// ─── parseScanRequest ─────────────────────────────────────────────────────

Deno.test("sin body, body vacío o sin follow_up_id → barrido automático", () => {
  for (const b of [null, undefined, {}, [], "x", { step: 2 }, { follow_up_id: null }]) {
    assertEquals(parseScanRequest(b), { kind: "sweep" });
  }
});

Deno.test("reintento: follow_up_id + step (+ force/confirm_resend solo si son true)", () => {
  assertEquals(parseScanRequest({ follow_up_id: ATTEMPT_ID, step: 2, force: true, confirm_resend: "true" }), {
    kind: "retry",
    followUpId: ATTEMPT_ID,
    step: 2,
    force: true,
    confirmResend: false,
  });
});

Deno.test("reintento con follow_up_id inválido o sin step entero ≥ 1 → inválido (400), nunca barrido", () => {
  for (const b of [
    { follow_up_id: "no-es-uuid", step: 1 },
    { follow_up_id: 5, step: 1 },
    { follow_up_id: ATTEMPT_ID },
    { follow_up_id: ATTEMPT_ID, step: 0 },
    { follow_up_id: ATTEMPT_ID, step: 1.5 },
    { follow_up_id: ATTEMPT_ID, step: "2" },
  ]) {
    assertEquals(parseScanRequest(b).kind, "invalid", JSON.stringify(b));
  }
});

Deno.test("el lead_id del formato viejo ya no dispara un reintento (sin intento no hay a qué atarlo)", () => {
  assertEquals(parseScanRequest({ lead_id: LEAD_ID, force: true }), { kind: "sweep" });
});

// ─── retryOutcomeFor ──────────────────────────────────────────────────────

Deno.test("reserva rechazada porque hubo un intento posterior (superseded) → conflict (409)", () => {
  const r = retryOutcomeFor({ kind: "refused", reason: "superseded", message: CLAIM_MESSAGES.superseded });
  assertEquals(r, { ok: false, conflict: true, skipped: CLAIM_MESSAGES.superseded });
});

Deno.test("reserva rechazada porque el lead avanzó (step_changed) → conflict (409)", () => {
  const r = retryOutcomeFor({ kind: "refused", reason: "step_changed", message: CLAIM_MESSAGES.step_changed });
  assertEquals(r, { ok: false, conflict: true, skipped: CLAIM_MESSAGES.step_changed });
});

Deno.test("reserva rechazada (otro worker lo está enviando) → skipped con el motivo, nunca un envío", () => {
  const r = retryOutcomeFor({ kind: "refused", reason: "in_flight", message: CLAIM_MESSAGES.in_flight });
  assertEquals(r, { ok: false, skipped: CLAIM_MESSAGES.in_flight });
});

Deno.test("reserva rechazada por intento anterior sin confirmar → unconfirmed:true para pedir confirmación", () => {
  const r = retryOutcomeFor({ kind: "refused", reason: "unconfirmed", message: CLAIM_MESSAGES.unconfirmed });
  assertEquals(r, { ok: false, unconfirmed: true, skipped: CLAIM_MESSAGES.unconfirmed });
});

Deno.test("enviado → ok:true", () => {
  assertEquals(retryOutcomeFor({ kind: "sent", variables: { a: "b" } }), { ok: true, status: "sent", error: null });
});

Deno.test("falló antes de enviar → ok:false con el error real de ESTE intento", () => {
  const r = retryOutcomeFor({ kind: "failed", error: "Kommo API error: 500" });
  assertEquals(r, { ok: false, status: "failed", error: "Kommo API error: 500" });
});

Deno.test("cortado después de disparar → failed + unconfirmed (el panel no lo presenta como reintentable a ciegas)", () => {
  const r = retryOutcomeFor({ kind: "unconfirmed", error: "sin confirmar: x" });
  assertEquals(r, { ok: false, status: "failed", unconfirmed: true, error: "sin confirmar: x" });
});

Deno.test("el agente decidió no escribir → skipped con el motivo", () => {
  assertEquals(retryOutcomeFor({ kind: "released", reason: "el agente decidió no escribir hoy" }), {
    ok: false,
    skipped: "el agente decidió no escribir hoy",
  });
});

Deno.test("lease perdido → skipped (no se envió nada)", () => {
  const r = retryOutcomeFor({ kind: "lease_lost" });
  assertEquals(r.ok, false);
  assertEquals(typeof r.skipped, "string");
});
