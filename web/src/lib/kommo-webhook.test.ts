// Tests de la lógica pura del webhook autenticado de Kommo.
// Correr con: cd web && node --test src/lib/kommo-webhook.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateWebhookSecret,
  maskDestination,
  planWebhookUpdate,
  SETTINGS_DEFAULT,
  webhookDestination,
} from "./kommo-webhook.ts";

const BASE = "https://abc.supabase.co";

test("webhookDestination: agrega ?token= (codificado) y respeta la barra final", () => {
  assert.equal(webhookDestination(BASE, "abc123"), `${BASE}/functions/v1/kommo-webhook?token=abc123`);
  assert.equal(webhookDestination(`${BASE}/`, "a b"), `${BASE}/functions/v1/kommo-webhook?token=a%20b`);
  assert.equal(webhookDestination(BASE, null), `${BASE}/functions/v1/kommo-webhook`);
});

test("maskDestination: el secreto no sale en logs", () => {
  assert.equal(maskDestination(`${BASE}/functions/v1/kommo-webhook?token=SECRETO`), `${BASE}/functions/v1/kommo-webhook?token=***`);
});

test("planWebhookUpdate: migra del webhook sin secreto al nuevo conservando los eventos que el operador sumó", () => {
  const nuevo = webhookDestination(BASE, "t");
  const plan = planWebhookUpdate(
    [
      { destination: `${BASE}/functions/v1/kommo-webhook`, settings: ["add_lead", "status_lead", "add_message"] },
      { destination: "https://otra.app/hook", settings: ["add_lead"] },
    ],
    nuevo,
  );
  assert.deepEqual(plan.settings, ["add_lead", "status_lead", "add_message"]);
  assert.deepEqual(plan.toDelete, [`${BASE}/functions/v1/kommo-webhook`]); // la ajena no se toca
  assert.equal(plan.alreadyRegistered, false);
});

test("planWebhookUpdate: ya registrado → nada que borrar; sin hooks → settings por defecto", () => {
  const dest = webhookDestination(BASE, "t");
  const ya = planWebhookUpdate([{ destination: dest, settings: ["add_lead"] }], dest);
  assert.equal(ya.alreadyRegistered, true);
  assert.deepEqual(ya.toDelete, []);
  assert.deepEqual(planWebhookUpdate([], dest).settings, SETTINGS_DEFAULT);
});

test("generateWebhookSecret: 48 hex y distinto cada vez", () => {
  const a = generateWebhookSecret();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, generateWebhookSecret());
});
