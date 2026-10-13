// _shared/auth.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/auth.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  authorizeInternal,
  callInternal,
  internalHeaders,
  isInternalSecretValid,
  resetInternalSecretCache,
  timingSafeEqual,
} from "./auth.ts";

function fakeSupabase(valor: string | null, error: unknown = null) {
  resetInternalSecretCache();
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: valor ? { valor } : null, error }) }),
      }),
    }),
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("timingSafeEqual: iguales, distintos y de distinto largo", () => {
  assertEquals(timingSafeEqual("abc", "abc"), true);
  assertEquals(timingSafeEqual("abc", "abd"), false);
  assertEquals(timingSafeEqual("abc", "abcd"), false);
  assertEquals(timingSafeEqual("", ""), true);
});

Deno.test("isInternalSecretValid: fail-closed si falta el header o el secreto", () => {
  assertEquals(isInternalSecretValid(null, "s"), false);
  assertEquals(isInternalSecretValid("s", null), false);
  assertEquals(isInternalSecretValid("", ""), false);
  assertEquals(isInternalSecretValid("s", "s"), true);
});

Deno.test("authorizeInternal: sin header -> 401 genérico", async () => {
  const r = await authorizeInternal(new Request("http://x", { method: "POST" }), fakeSupabase("sec-1"));
  assertEquals(r?.status, 401);
  assertEquals(await r?.json(), { ok: false, error: "unauthorized" });
});

Deno.test("authorizeInternal: secreto incorrecto -> 401", async () => {
  const req = new Request("http://x", { method: "POST", headers: { "x-internal-secret": "otro" } });
  assertEquals((await authorizeInternal(req, fakeSupabase("sec-2")))?.status, 401);
});

Deno.test("authorizeInternal: secreto correcto -> null (autorizado)", async () => {
  const req = new Request("http://x", { method: "POST", headers: { "x-internal-secret": "sec-3" } });
  assertEquals(await authorizeInternal(req, fakeSupabase("sec-3")), null);
});

Deno.test("authorizeInternal: error de la base o tabla vacía -> 401 (fail-closed)", async () => {
  const req = new Request("http://x", { method: "POST", headers: { "x-internal-secret": "cualquiera-4" } });
  assertEquals((await authorizeInternal(req, fakeSupabase(null, { message: "boom" })))?.status, 401);
  assertEquals((await authorizeInternal(req, fakeSupabase(null)))?.status, 401);
});

Deno.test("internalHeaders: manda x-internal-secret cuando existe, y no inventa uno cuando falta", async () => {
  assertEquals((await internalHeaders(fakeSupabase("sec-5")))["x-internal-secret"], "sec-5");
  assertEquals((await internalHeaders(fakeSupabase(null)))["x-internal-secret"], undefined);
});

Deno.test("callInternal: POST a /functions/v1/<slug> con el secreto, y el gate de la función destino lo acepta", async () => {
  Deno.env.set("SUPABASE_URL", "https://ref.supabase.co");
  const original = globalThis.fetch;
  let visto: Request | null = null;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    visto = new Request(String(input), init);
    return Promise.resolve(new Response("{}", { status: 202 }));
  }) as typeof fetch;
  try {
    await callInternal(fakeSupabase("sec-6"), "generate-response", { a: 1 });
  } finally {
    globalThis.fetch = original;
  }
  const req = visto as unknown as Request;
  assertEquals(req.url, "https://ref.supabase.co/functions/v1/generate-response");
  assertEquals(req.method, "POST");
  // lo que mandó pasa el gate del destino (misma tabla de secretos)
  assertEquals(await authorizeInternal(req, fakeSupabase("sec-6")), null);
  // y sin secreto en la tabla el destino lo rechaza (fail-closed)
  assertEquals((await authorizeInternal(req, fakeSupabase(null)))?.status, 401);
});
