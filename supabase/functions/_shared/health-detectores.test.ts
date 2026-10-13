// _shared/health-detectores.test.ts
// Deno test para los cuatro detectores puros de health-scan.
// Correr con: deno test supabase/functions/_shared/health-detectores.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  decidirColaAtascada,
  decidirIngestaDetenida,
  decidirTokenKommo,
  decidirWebhookKommo,
} from "./health-detectores.ts";

const PATH = "/functions/v1/kommo-webhook";

// ---------------- decidirWebhookKommo ----------------

Deno.test("webhook: sin ningún hook nuestro registrado → incidente kommo_webhook_caido", () => {
  const inc = decidirWebhookKommo(
    [{ destination: "https://otra-app.example.com/hooks/x", disabled: false }],
    PATH,
  );
  assertEquals(inc?.kind, "kommo_webhook_caido");
});

Deno.test("webhook: nuestro hook habilitado → sano (null)", () => {
  const inc = decidirWebhookKommo(
    [{ destination: `https://xyz.supabase.co${PATH}`, disabled: false }],
    PATH,
  );
  assertEquals(inc, null);
});

Deno.test("webhook: nuestro único hook deshabilitado → incidente", () => {
  const inc = decidirWebhookKommo(
    [{ destination: `https://xyz.supabase.co${PATH}`, disabled: true }],
    PATH,
  );
  assertEquals(inc?.kind, "kommo_webhook_caido");
  assertEquals(inc?.severity, "critical");
});

Deno.test("webhook: dos hooks nuestros, uno habilitado → sano (no están TODOS deshabilitados)", () => {
  const inc = decidirWebhookKommo(
    [
      { destination: `https://xyz.supabase.co${PATH}`, disabled: true },
      { destination: `https://xyz.supabase.co${PATH}?v=2`, disabled: false },
    ],
    PATH,
  );
  assertEquals(inc, null);
});

Deno.test("webhook: lista vacía → incidente (no hay ninguno registrado)", () => {
  const inc = decidirWebhookKommo([], PATH);
  assertEquals(inc?.kind, "kommo_webhook_caido");
});

// ---------------- decidirTokenKommo ----------------

Deno.test("token: 401 → incidente kommo_token", () => {
  const inc = decidirTokenKommo(401);
  assertEquals(inc?.kind, "kommo_token");
  assertEquals(inc?.metadata?.status, 401);
});

Deno.test("token: 403 → incidente kommo_token", () => {
  const inc = decidirTokenKommo(403);
  assertEquals(inc?.kind, "kommo_token");
});

Deno.test("token: 200 → sano (null)", () => {
  assertEquals(decidirTokenKommo(200), null);
});

Deno.test("token: 500 (transitorio de Kommo, no es incidente nuestro) → sano (null)", () => {
  assertEquals(decidirTokenKommo(500), null);
});

// ---------------- decidirIngestaDetenida ----------------

Deno.test("ingesta: nunca entró nada (null) → sano, no hay nada que romper", () => {
  assertEquals(decidirIngestaDetenida(null, 45, null), null);
});

Deno.test("ingesta: por debajo del umbral → sano", () => {
  assertEquals(decidirIngestaDetenida(10, 45, "2026-09-10T00:00:00.000Z"), null);
});

Deno.test("ingesta: justo en el umbral → incidente (>=, no solo >)", () => {
  const inc = decidirIngestaDetenida(45, 45, "2026-09-10T00:00:00.000Z");
  assertEquals(inc?.kind, "ingesta_detenida");
});

Deno.test("ingesta: muy por encima del umbral → incidente con los minutos en el título", () => {
  const inc = decidirIngestaDetenida(120, 45, "2026-09-10T00:00:00.000Z");
  assertEquals(inc?.kind, "ingesta_detenida");
  assertEquals(inc?.title.includes("120"), true);
});

// ---------------- decidirColaAtascada ----------------

Deno.test("cola: por debajo del umbral → sano", () => {
  assertEquals(decidirColaAtascada(10, 50, 15), null);
});

Deno.test("cola: justo en el umbral → incidente (>=, no solo >)", () => {
  const inc = decidirColaAtascada(50, 50, 15);
  assertEquals(inc?.kind, "cola_atascada");
  assertEquals(inc?.severity, "warning");
});

Deno.test("cola: muy por encima del umbral → incidente con el conteo en el título", () => {
  const inc = decidirColaAtascada(200, 50, 15);
  assertEquals(inc?.title.includes("200"), true);
});
