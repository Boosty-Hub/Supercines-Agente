// _shared/followup-retry.test.ts
// Deno test para evaluateRetryGate() / interpretRetryOutcome().
// Correr con: deno test --allow-read supabase/functions/_shared/followup-retry.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  evaluateRetryGate,
  interpretRetryOutcome,
  type RetryConfigRow,
  type RetryLeadRow,
} from "./followup-retry.ts";

const okLead: RetryLeadRow = {
  follow_up_step: 1,
  follow_up_status: "active",
  opted_out: false,
  kommo_lead_id: 555,
};

const okCfg: RetryConfigRow = { enabled: true, max_follow_ups: 3 };

// ─── evaluateRetryGate ────────────────────────────────────────────────────

Deno.test("lead que no existe → bloqueado, motivo legible", () => {
  const r = evaluateRetryGate(null, okCfg);
  assertEquals(r, { ok: false, reason: "el lead no existe" });
});

Deno.test("lead opted_out → bloqueado ANTES de mirar la config (opt-out es el freno más duro)", () => {
  const r = evaluateRetryGate({ ...okLead, opted_out: true }, null);
  assertEquals(r, { ok: false, reason: "el lead pidió no recibir más mensajes (opt-out)" });
});

for (const status of ["responded", "stopped", "exhausted"]) {
  Deno.test(`estado terminal "${status}" → bloqueado con el estado en el motivo`, () => {
    const r = evaluateRetryGate({ ...okLead, follow_up_status: status }, okCfg);
    assertEquals(r, { ok: false, reason: `el seguimiento de este lead está en estado "${status}"` });
  });
}

Deno.test("estado no terminal (ej. active o null) → no lo bloquea por estado", () => {
  const r1 = evaluateRetryGate({ ...okLead, follow_up_status: "active" }, okCfg);
  const r2 = evaluateRetryGate({ ...okLead, follow_up_status: null }, okCfg);
  assertEquals(r1.ok, true);
  assertEquals(r2.ok, true);
});

Deno.test("sin kommo_lead_id → bloqueado, no se puede enviar", () => {
  const r = evaluateRetryGate({ ...okLead, kommo_lead_id: null }, okCfg);
  assertEquals(r, { ok: false, reason: "el lead no tiene kommo_lead_id — no se puede enviar" });
});

Deno.test("config ausente → bloqueado (seguimiento apagado)", () => {
  const r = evaluateRetryGate(okLead, null);
  assertEquals(r, { ok: false, reason: "el seguimiento está apagado en la configuración" });
});

Deno.test("config con enabled=false → bloqueado", () => {
  const r = evaluateRetryGate(okLead, { enabled: false, max_follow_ups: 3 });
  assertEquals(r, { ok: false, reason: "el seguimiento está apagado en la configuración" });
});

Deno.test("follow_up_step + 1 ya supera max_follow_ups → bloqueado con el tope en el motivo", () => {
  const r = evaluateRetryGate({ ...okLead, follow_up_step: 3 }, { enabled: true, max_follow_ups: 3 });
  assertEquals(r, { ok: false, reason: "ya alcanzó el máximo de 3 seguimientos" });
});

Deno.test("follow_up_step + 1 == max_follow_ups (el último posible) → permitido", () => {
  const r = evaluateRetryGate({ ...okLead, follow_up_step: 2 }, { enabled: true, max_follow_ups: 3 });
  assertEquals(r, { ok: true, step: 3, maxFollowUps: 3 });
});

Deno.test("lead nunca contactado (follow_up_step null) → reintenta el paso 1", () => {
  const r = evaluateRetryGate({ ...okLead, follow_up_step: null }, okCfg);
  assertEquals(r, { ok: true, step: 1, maxFollowUps: 3 });
});

Deno.test("max_follow_ups ausente en config → default 3 (mismo default que el resto del módulo)", () => {
  const r = evaluateRetryGate({ ...okLead, follow_up_step: 2 }, { enabled: true, max_follow_ups: null });
  assertEquals(r, { ok: true, step: 3, maxFollowUps: 3 });
});

Deno.test("caso feliz completo → ok con el próximo paso y el tope", () => {
  const r = evaluateRetryGate(okLead, okCfg);
  assertEquals(r, { ok: true, step: 2, maxFollowUps: 3 });
});

// ─── interpretRetryOutcome ────────────────────────────────────────────────

Deno.test("sin fila en follow_ups → skip silencioso, no se confunde con envío", () => {
  const r = interpretRetryOutcome(null, 2);
  assertEquals(r.ok, false);
  assertEquals(
    r.skipped,
    "el seguimiento se salteó sin intentar el envío (etapa o responsable fuera de la lista, o el agente decidió no escribir)"
  );
});

Deno.test("la fila más nueva es de OTRO paso (uno viejo) → también es skip silencioso", () => {
  const r = interpretRetryOutcome({ status: "sent", error: null, step: 1 }, 2);
  assertEquals(r.ok, false);
  assertEquals(r.skipped?.length && r.skipped.length > 0, true);
});

Deno.test("fila del paso pedido con status=sent → ok:true, sin skipped", () => {
  const r = interpretRetryOutcome({ status: "sent", error: null, step: 2 }, 2);
  assertEquals(r, { ok: true, status: "sent", error: null });
});

Deno.test("fila del paso pedido con status=failed → ok:false y el error real, no un skip inventado", () => {
  const r = interpretRetryOutcome({ status: "failed", error: "Kommo API error: 500", step: 2 }, 2);
  assertEquals(r, { ok: false, status: "failed", error: "Kommo API error: 500" });
});
