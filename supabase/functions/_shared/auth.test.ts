// _shared/auth.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/auth.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { authorizeInternal, isInternalSecretValid, resetInternalSecretCache, timingSafeEqual } from "./auth.ts";

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
