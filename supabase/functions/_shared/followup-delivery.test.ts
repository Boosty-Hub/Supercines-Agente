// _shared/followup-delivery.test.ts
// Cómo se resuelve un seguimiento cortado DESPUÉS de disparar la plantilla, con un
// Kommo falso (fetch simulado) recorriendo el mismo camino que follow-up-scan:
//   1. foto previa: fetchOutgoingEventIds antes del salesbot → baseline (o null si falló);
//   2. recuperación: fetchOutgoingEvents del lead → resolveDeadFollowUp(baseline, current, sending_at).
// Solo es «enviado» un saliente DE ESE LEAD, que no estaba en la foto y posterior a la marca.
// Correr con: deno test --allow-read supabase/functions/_shared/followup-delivery.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { fetchOutgoingEventIds, fetchOutgoingEvents } from "./kommo.ts";
import { resolveDeadFollowUp } from "./followup-claim.ts";

const LEAD = 555;
const SENDING_AT = "2026-10-13T12:00:00.000Z";
const SENDING_S = Date.parse(SENDING_AT) / 1000;

type KommoEvent = { id: string; entity_id: number; entity_type?: string; created_at: number };

/** Kommo falso: cada llamada a /api/v4/events consume la próxima respuesta del guion. */
function fakeKommo(script: Array<KommoEvent[] | "error">): typeof fetch {
  let i = 0;
  return ((input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/api/v4/events")) return Promise.reject(new Error(`URL inesperada: ${url}`));
    const step = script[Math.min(i++, script.length - 1)];
    if (step === "error") return Promise.resolve(new Response("bad gateway", { status: 502 }));
    return Promise.resolve(new Response(JSON.stringify({ _embedded: { events: step } }), { status: 200 }));
  }) as typeof fetch;
}

/** Foto previa + recuperación contra el Kommo falso; devuelve el resultado y la foto guardada. */
async function sendThenRecover(script: Array<KommoEvent[] | "error">) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeKommo(script);
  try {
    const snapshot = await fetchOutgoingEventIds(LEAD, "dominio.kommo.com", "token");
    // Lo que follow-up-scan le pasa a mark_follow_up_sending como p_baseline.
    const baseline = snapshot ? [...snapshot] : null;
    const current = baseline ? await fetchOutgoingEvents(LEAD, "dominio.kommo.com", "token") : null;
    return { baseline, outcome: resolveDeadFollowUp(baseline, current, SENDING_AT) };
  } finally {
    globalThis.fetch = original;
  }
}

const old = { id: "old", entity_id: LEAD, entity_type: "lead", created_at: SENDING_S - 600 };

Deno.test("foto previa fallida → baseline null → «sin confirmar» aunque después aparezca un saliente", async () => {
  const { baseline, outcome } = await sendThenRecover([
    "error",
    [old, { id: "nuevo", entity_id: LEAD, entity_type: "lead", created_at: SENDING_S + 5 }],
  ]);
  assertEquals(baseline, null);
  assertEquals(outcome.kind, "unconfirmed");
});

Deno.test("Kommo ilegible en la recuperación → «sin confirmar»", async () => {
  const { baseline, outcome } = await sendThenRecover([[old], "error"]);
  assertEquals(baseline, ["old"]);
  assertEquals(outcome.kind, "unconfirmed");
});

Deno.test("un saliente nuevo del lead ANTERIOR a la marca no cuenta → «sin confirmar»", async () => {
  const { outcome } = await sendThenRecover([
    [old],
    [old, { id: "manual", entity_id: LEAD, entity_type: "lead", created_at: SENDING_S - 30 }],
  ]);
  assertEquals(outcome.kind, "unconfirmed");
});

Deno.test("un saliente posterior de OTRO lead (o de un contacto con el mismo número) no cuenta", async () => {
  const { outcome } = await sendThenRecover([
    [old],
    [
      old,
      { id: "otro-lead", entity_id: 999, entity_type: "lead", created_at: SENDING_S + 5 },
      { id: "contacto", entity_id: LEAD, entity_type: "contact", created_at: SENDING_S + 6 },
    ],
  ]);
  assertEquals(outcome.kind, "unconfirmed");
});

Deno.test("un saliente nuevo del lead posterior a la marca → enviado (recuperado)", async () => {
  const { outcome } = await sendThenRecover([
    [old],
    [old, { id: "plantilla", entity_id: LEAD, entity_type: "lead", created_at: SENDING_S + 4 }],
  ]);
  assertEquals(outcome, { kind: "sent", recovered: true });
});
