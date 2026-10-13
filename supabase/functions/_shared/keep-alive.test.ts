import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { keepAlive } from "./keep-alive.ts";

Deno.test("keepAlive registra el trabajo en waitUntil y devuelve su resultado", async () => {
  const held: Promise<unknown>[] = [];
  const out = await keepAlive(Promise.resolve(42), { waitUntil: (p) => held.push(p) });
  assertEquals(out, 42);
  assertEquals(held.length, 1);
});

Deno.test("keepAlive: el error llega a quien espera; la copia de waitUntil no queda rechazada", async () => {
  const held: Promise<unknown>[] = [];
  await assertRejects(() => keepAlive(Promise.reject(new Error("x")), { waitUntil: (p) => held.push(p) }), Error, "x");
  assertEquals(await held[0], undefined);
});

Deno.test("keepAlive sin EdgeRuntime es transparente", async () => {
  assertEquals(await keepAlive(Promise.resolve("ok"), undefined), "ok");
});
