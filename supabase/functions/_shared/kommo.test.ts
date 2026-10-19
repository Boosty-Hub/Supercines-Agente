// _shared/kommo.test.ts
// Deno tests para las dos defensas del camino SALIENTE portadas desde KIA-Agente:
//
//   1. sanitizeKommoFieldValue — Kommo guarda los custom fields en MySQL utf8mb3
//      (3 bytes): un emoji (4 bytes) trunca el valor guardado desde ese punto EN
//      SILENCIO. La sanitización saca los caracteres astral (+ los joiners que
//      quedan colgando) para que el texto completo sobreviva.
//   2. fetchOutgoingEventIds / verifyOutgoingDelivery — `salesbot/run` responde
//      202 `{success:true}` SIEMPRE, sin probar que el mensaje llegó al canal. La
//      única señal real de entrega es un evento `outgoing_chat_message` NUEVO.
//
// Correr con: deno test --allow-read supabase/functions/_shared/kommo.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { FakeTime } from "jsr:@std/testing@^1.0.0/time";
import {
  sanitizeKommoFieldValue,
  patchLeadField,
  patchContactField,
  fetchOutgoingEventIds,
  fetchOutgoingEvents,
  outgoingEventsOfLead,
  verifyOutgoingDelivery,
  addLeadNote,
  addLeadTags,
  fetchTalk,
  KommoHttpError,
} from "./kommo.ts";

// Reemplaza globalThis.fetch durante `run()` y lo restaura después, incluso si
// `run()` throwea — evita que el mock de un test se filtre al siguiente.
function withFetchMock<T>(mock: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

// ---- sanitizeKommoFieldValue ----

Deno.test("sanitizeKommoFieldValue: caso real reportado — el emoji se saca y el texto sobrevive completo", () => {
  // Repro real: Kommo truncaba "¡Hola Mauricio! Bienvenido " y perdía todo lo
  // que seguía al emoji. Acá el emoji se saca ANTES de mandar, así que el texto
  // completo llega a Kommo (y no hay nada que truncar).
  const input = "¡Hola Mauricio! Bienvenido 😊 Vi tu comentario";
  assertEquals(sanitizeKommoFieldValue(input), "¡Hola Mauricio! Bienvenido Vi tu comentario");
});

Deno.test("sanitizeKommoFieldValue: símbolos BMP de 3 bytes (✓, ☀) se conservan", () => {
  assertEquals(sanitizeKommoFieldValue("Todo ✓ listo, ☀ afuera"), "Todo ✓ listo, ☀ afuera");
});

Deno.test("sanitizeKommoFieldValue: emoji ZWJ (familia) desaparece entero, joiners colgantes incluidos", () => {
  // 👨‍👩‍👧 = hombre + ZWJ + mujer + ZWJ + niña. Los tres pictogramas son
  // astral (>0xFFFF) y se sacan; el ZWJ es BMP pero queda colgando sin pareja,
  // así que también se saca por estar en `danglers`.
  assertEquals(sanitizeKommoFieldValue("Familia 👨‍👩‍👧 feliz"), "Familia feliz");
});

Deno.test("sanitizeKommoFieldValue: keycap conserva el dígito y saca los joiners BMP", () => {
  // 1️⃣ = dígito '1' (BMP) + variation selector FE0F (BMP) + combining keycap
  // 20E3 (BMP) — ninguno es astral, por eso están explícitos en `danglers`.
  assertEquals(sanitizeKommoFieldValue("Nivel 1️⃣ completo"), "Nivel 1 completo");
});

Deno.test("sanitizeKommoFieldValue: emoji al final se recorta junto con el espacio sobrante", () => {
  assertEquals(sanitizeKommoFieldValue("Gracias 😊"), "Gracias");
});

Deno.test("sanitizeKommoFieldValue: sin emojis, el texto no cambia (salvo trim de bordes)", () => {
  assertEquals(sanitizeKommoFieldValue("  Hola, todo en orden.  "), "Hola, todo en orden.");
});

// ---- call sites: patchLeadField / patchContactField sanitizan antes de mandar ----

Deno.test("patchLeadField: manda el value SANITIZADO en el body, no el crudo", async () => {
  let capturedBody: string | null = null;
  await withFetchMock(
    ((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    () => patchLeadField(1, 99, "Hola 😊 mundo", "dominio.kommo.com", "token")
  );
  const parsed = JSON.parse(capturedBody!);
  assertEquals(parsed.custom_fields_values[0].values[0].value, "Hola mundo");
});

Deno.test("patchContactField: manda el value SANITIZADO en el body", async () => {
  let capturedBody: string | null = null;
  await withFetchMock(
    ((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    () => patchContactField(1, 99, "Bienvenido 🎉", "dominio.kommo.com", "token")
  );
  const parsed = JSON.parse(capturedBody!);
  assertEquals(parsed.custom_fields_values[0].values[0].value, "Bienvenido");
});

// ---- fetchOutgoingEventIds ----

Deno.test("fetchOutgoingEventIds: filtra por entity_id y devuelve solo esos ids", async () => {
  const result = await withFetchMock(
    (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            _embedded: {
              events: [
                { id: "a1", entity_id: 555 },
                { id: "a2", entity_id: 999 },
                { id: "a3", entity_id: 555 },
              ],
            },
          }),
          { status: 200 }
        )
      )) as typeof fetch,
    () => fetchOutgoingEventIds(555, "dominio.kommo.com", "token")
  );
  assertEquals(result, new Set(["a1", "a3"]));
});

Deno.test("fetchOutgoingEventIds: error de red → null (no se pudo leer), nunca un set vacío", async () => {
  const result = await withFetchMock(
    (() => Promise.reject(new Error("network down"))) as typeof fetch,
    () => fetchOutgoingEventIds(555, "dominio.kommo.com", "token")
  );
  assertEquals(result, null);
});

Deno.test("fetchOutgoingEventIds: respuesta no-OK → null", async () => {
  const result = await withFetchMock(
    (() => Promise.resolve(new Response("error", { status: 500 }))) as typeof fetch,
    () => fetchOutgoingEventIds(555, "dominio.kommo.com", "token")
  );
  assertEquals(result, null);
});

Deno.test("fetchOutgoingEventIds: respuesta con forma inesperada → null", async () => {
  const result = await withFetchMock(
    (() => Promise.resolve(new Response(JSON.stringify({ title: "x" }), { status: 200 }))) as typeof fetch,
    () => fetchOutgoingEventIds(555, "dominio.kommo.com", "token")
  );
  assertEquals(result, null);
});

Deno.test("fetchOutgoingEventIds: 204 (Kommo sin eventos) → set vacío (lectura válida)", async () => {
  const result = await withFetchMock(
    (() => Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch,
    () => fetchOutgoingEventIds(555, "dominio.kommo.com", "token")
  );
  assertEquals(result, new Set());
});

Deno.test("fetchOutgoingEvents: solo ESE lead (no otro lead ni un contacto con el mismo número), con su fecha", async () => {
  const result = await withFetchMock(
    (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            _embedded: {
              events: [
                { id: "a1", entity_id: 555, entity_type: "lead", created_at: 1760356800 },
                { id: "a2", entity_id: 999, entity_type: "lead", created_at: 1760356801 },
                { id: "a3", entity_id: 555, entity_type: "contact", created_at: 1760356802 },
                { id: "a4", entity_id: "555", entity_type: "lead" },
              ],
            },
          }),
          { status: 200 }
        )
      )) as typeof fetch,
    () => fetchOutgoingEvents(555, "dominio.kommo.com", "token")
  );
  assertEquals(result, [
    { id: "a1", createdAt: 1760356800 },
    { id: "a4", createdAt: null },
  ]);
});

Deno.test("outgoingEventsOfLead: sin _embedded.events → null; entradas basura se ignoran", () => {
  assertEquals(outgoingEventsOfLead(null, 1), null);
  assertEquals(outgoingEventsOfLead({ _embedded: {} }, 1), null);
  assertEquals(outgoingEventsOfLead({ _embedded: { events: [null, 3, { entity_id: 1 }] } }, 1), []);
});

// ---- verifyOutgoingDelivery ----
// Usamos FakeTime para no esperar de verdad los ~2.5-3.5s de cada poll.

Deno.test("verifyOutgoingDelivery: aparece un outgoing_chat_message NUEVO → true", async () => {
  using time = new FakeTime();
  const baseline = new Set(["old-1"]);

  const result = await withFetchMock(
    (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            _embedded: {
              events: [
                { id: "old-1", entity_id: 555 },
                { id: "new-1", entity_id: 555 },
              ],
            },
          }),
          { status: 200 }
        )
      )) as typeof fetch,
    async () => {
      const promise = verifyOutgoingDelivery(555, baseline, "dominio.kommo.com", "token", 12000);
      await time.tickAsync(2500); // primer chequeo, tras el respiro corto
      return await promise;
    }
  );

  assertEquals(result, true);
});

Deno.test("verifyOutgoingDelivery: el 202 de salesbot/run NO es entrega — sin novedad hasta el timeout → false", async () => {
  using time = new FakeTime();
  const baseline = new Set(["old-1"]);

  const result = await withFetchMock(
    (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ _embedded: { events: [{ id: "old-1", entity_id: 555 }] } }),
          { status: 200 }
        )
      )) as typeof fetch,
    async () => {
      const promise = verifyOutgoingDelivery(555, baseline, "dominio.kommo.com", "token", 8000);
      // Tres polls: 2500 + 3500 + 3500 = 9500ms, recién ahí el while(Date.now()
      // < deadline) da falso y corta sin agendar un cuarto poll.
      await time.tickAsync(2500);
      await time.tickAsync(3500);
      await time.tickAsync(3500);
      return await promise;
    }
  );

  assertEquals(result, false);
});

Deno.test("verifyOutgoingDelivery: un evento que YA estaba en el baseline no cuenta como entrega", async () => {
  using time = new FakeTime();
  // El único evento que trae Kommo es el mismo que ya existía antes de disparar
  // el bot — no es una entrega nueva, así que no debe dar `true` en el primer poll.
  const baseline = new Set(["old-1"]);

  const result = await withFetchMock(
    (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ _embedded: { events: [{ id: "old-1", entity_id: 555 }] } }),
          { status: 200 }
        )
      )) as typeof fetch,
    async () => {
      const promise = verifyOutgoingDelivery(555, baseline, "dominio.kommo.com", "token", 2500);
      await time.tickAsync(2500);
      return await promise;
    }
  );

  assertEquals(result, false);
});

// ---- addLeadNote ----

Deno.test("addLeadNote: manda el texto SANITIZADO, como arreglo de un elemento", async () => {
  let capturedBody: string | null = null;
  await withFetchMock(
    ((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    () => addLeadNote(1, "Derivado a asesor 😊", "dominio.kommo.com", "token")
  );
  const parsed = JSON.parse(capturedBody!);
  assertEquals(parsed, [{ note_type: "common", params: { text: "Derivado a asesor" } }]);
});

Deno.test("addLeadNote: respuesta no-OK throwea (nunca falla en silencio)", async () => {
  let threw = false;
  await withFetchMock(
    (() => Promise.resolve(new Response("error", { status: 500 }))) as typeof fetch,
    async () => {
      try {
        await addLeadNote(1, "texto", "dominio.kommo.com", "token");
      } catch {
        threw = true;
      }
    }
  );
  assertEquals(threw, true);
});

// ---- addLeadTags ----

Deno.test("addLeadTags: PATCH manda la UNIÓN (existentes + nuevas), nunca solo las nuevas", async () => {
  let capturedBody: string | null = null;
  let calls = 0;
  await withFetchMock(
    ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        // GET de las tags existentes
        return Promise.resolve(
          new Response(JSON.stringify({ _embedded: { tags: [{ id: 1, name: "vip" }] } }), { status: 200 })
        );
      }
      capturedBody = init?.body as string;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    () => addLeadTags(1, ["urgente", "VIP"], "dominio.kommo.com", "token")
  );
  const parsed = JSON.parse(capturedBody!);
  // "VIP" ya existía (case-insensitive) → solo se agrega "urgente", pero el
  // PATCH tiene que llevar TAMBIÉN la tag existente por id (Kommo reemplaza el
  // set completo en cada PATCH).
  assertEquals(parsed._embedded.tags, [{ id: 1 }, { name: "urgente" }]);
});

Deno.test("addLeadTags: si todas las candidatas ya existen, NO hace el PATCH (no-op)", async () => {
  let calls = 0;
  const result = await withFetchMock(
    (() => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify({ _embedded: { tags: [{ id: 1, name: "vip" }] } }), { status: 200 })
      );
    }) as typeof fetch,
    () => addLeadTags(1, ["VIP"], "dominio.kommo.com", "token")
  );
  assertEquals(result, { added: [] });
  assertEquals(calls, 1); // solo el GET, ningún PATCH
});

Deno.test("addLeadTags: GET no-OK throwea", async () => {
  let threw = false;
  await withFetchMock(
    (() => Promise.resolve(new Response("error", { status: 500 }))) as typeof fetch,
    async () => {
      try {
        await addLeadTags(1, ["urgente"], "dominio.kommo.com", "token");
      } catch {
        threw = true;
      }
    }
  );
  assertEquals(threw, true);
});

Deno.test("sanitizeKommoFieldValue: saca surrogates sueltos (alto/bajo, medio y final) y no revienta el JSON", () => {
  for (const roto of ["\uD83Dhola", "ho\uDE0Ala", "hola\uD83D", "\uDE0Ahola\uD83D"]) {
    const out = sanitizeKommoFieldValue(roto);
    assertEquals(out, "hola");
    assertEquals(JSON.parse(JSON.stringify({ v: out })).v, "hola");
  }
});

// ---- fetchTalk (GET /api/v4/talks/{id}) ----

Deno.test("fetchTalk: pide /api/v4/talks/{id} con Bearer y devuelve el JSON", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const r = await withFetchMock(
    ((url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return Promise.resolve(new Response(JSON.stringify({ talk_id: 9001, entity_id: 42, entity_type: "lead" }), { status: 200 }));
    }) as typeof fetch,
    () => fetchTalk("acme.kommo.com", "tok", 9001),
  );
  assertEquals(seenUrl, "https://acme.kommo.com/api/v4/talks/9001");
  assertEquals(seenAuth, "Bearer tok");
  assertEquals(r, { talk_id: 9001, entity_id: 42, entity_type: "lead" });
});

Deno.test("fetchTalk: 404 y 204 = null (el talk no existe)", async () => {
  for (const status of [404, 204]) {
    const r = await withFetchMock(
      (() => Promise.resolve(new Response(status === 204 ? null : "no", { status }))) as typeof fetch,
      () => fetchTalk("acme.kommo.com", "tok", 1),
    );
    assertEquals(r, null);
  }
});

Deno.test("fetchTalk: 429 espera y reintenta (mismo manejo que el resto de la API)", async () => {
  let calls = 0;
  const waits: number[] = [];
  const r = await withFetchMock(
    (() => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? new Response("slow", { status: 429, headers: { "retry-after": "2" } })
          : new Response(JSON.stringify({ entity_id: 5 }), { status: 200 }),
      );
    }) as typeof fetch,
    () => fetchTalk("acme.kommo.com", "tok", 1, (ms) => { waits.push(ms); return Promise.resolve(); }),
  );
  assertEquals(calls, 2);
  assertEquals(waits, [2000]);
  assertEquals(r, { entity_id: 5 });
});

Deno.test("fetchTalk: 500 lanza KommoHttpError; cuerpo que no es JSON = null", async () => {
  let err: unknown;
  try {
    await withFetchMock(
      (() => Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch,
      () => fetchTalk("acme.kommo.com", "tok", 1),
    );
  } catch (e) {
    err = e;
  }
  assertEquals(err instanceof KommoHttpError, true);
  const r = await withFetchMock(
    (() => Promise.resolve(new Response("<html>", { status: 200 }))) as typeof fetch,
    () => fetchTalk("acme.kommo.com", "tok", 1),
  );
  assertEquals(r, null);
});

Deno.test("fetchTalk: pasa el AbortSignal al fetch (L4: el presupuesto de la fila corta la consulta)", async () => {
  const ctrl = new AbortController();
  let seen: AbortSignal | undefined;
  await withFetchMock(
    ((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    () => fetchTalk("acme.kommo.com", "tok", 1, undefined, ctrl.signal),
  );
  assertEquals(seen, ctrl.signal);
});
