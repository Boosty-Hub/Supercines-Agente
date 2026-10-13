// _shared/alerts-kommo-webhook.test.ts
// Deno test para shouldAlertKommoWebhookDisabled() / filterOurWebhooks().
// Correr con: deno test supabase/functions/_shared/alerts-kommo-webhook.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { filterOurWebhooks, shouldAlertKommoWebhookDisabled } from "./alerts-kommo-webhook.ts";

const PATH = "/functions/v1/kommo-webhook";

Deno.test("sin webhooks registrados → no alerta (no es este chequeo)", () => {
  assertEquals(shouldAlertKommoWebhookDisabled([], PATH), false);
});

Deno.test("webhooks de otras integraciones (destino no coincide) → no alerta", () => {
  const hooks = [
    { destination: "https://otra-app.example.com/hooks/x", disabled: true },
    { destination: "https://otro.example.com/webhooks/y", disabled: false },
  ];
  assertEquals(shouldAlertKommoWebhookDisabled(hooks, PATH), false);
});

Deno.test("nuestro webhook deshabilitado → alerta", () => {
  const hooks = [
    { destination: `https://xyz.supabase.co${PATH}`, disabled: true },
  ];
  assertEquals(shouldAlertKommoWebhookDisabled(hooks, PATH), true);
});

Deno.test("nuestro webhook habilitado → no alerta", () => {
  const hooks = [
    { destination: `https://xyz.supabase.co${PATH}`, disabled: false },
  ];
  assertEquals(shouldAlertKommoWebhookDisabled(hooks, PATH), false);
});

Deno.test("disabled ausente (undefined) se trata como habilitado → no alerta", () => {
  const hooks = [{ destination: `https://xyz.supabase.co${PATH}` }];
  assertEquals(shouldAlertKommoWebhookDisabled(hooks, PATH), false);
});

Deno.test("dos hooks nuestros, uno habilitado → no alerta (no están TODOS deshabilitados)", () => {
  const hooks = [
    { destination: `https://xyz.supabase.co${PATH}`, disabled: true },
    { destination: `https://xyz.supabase.co${PATH}?v=2`, disabled: false },
  ];
  assertEquals(shouldAlertKommoWebhookDisabled(hooks, PATH), false);
});

Deno.test("hook nuestro deshabilitado + hook ajeno habilitado → alerta (el ajeno no cuenta)", () => {
  const hooks = [
    { destination: `https://xyz.supabase.co${PATH}`, disabled: true },
    { destination: "https://otra-app.example.com/hooks/x", disabled: false },
  ];
  assertEquals(shouldAlertKommoWebhookDisabled(hooks, PATH), true);
});

Deno.test("destination null/undefined no rompe el filtro", () => {
  const hooks = [
    { destination: null, disabled: true },
    { disabled: false },
  ];
  assertEquals(filterOurWebhooks(hooks, PATH), []);
  assertEquals(shouldAlertKommoWebhookDisabled(hooks, PATH), false);
});

Deno.test("filterOurWebhooks devuelve solo los que matchean el path", () => {
  const ours = { destination: `https://xyz.supabase.co${PATH}`, disabled: true };
  const ajeno = { destination: "https://otra-app.example.com/hooks/x", disabled: true };
  assertEquals(filterOurWebhooks([ours, ajeno], PATH), [ours]);
});
