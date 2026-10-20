// _shared/dreams-lease.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/dreams-lease.test.ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { DREAMS_LEASE_SECONDS, interpretDreamsClaim } from "./dreams-lease.ts";

Deno.test("token → la corrida analiza", () => {
  assertEquals(interpretDreamsClaim({ data: "6f1c0b52-1111-4222-8333-944455556666", error: null }), {
    kind: "acquired", token: "6f1c0b52-1111-4222-8333-944455556666",
  });
});

Deno.test("null → otra corrida tiene el lease (busy)", () => {
  assertEquals(interpretDreamsClaim({ data: null, error: null }), { kind: "busy" });
});

Deno.test("sin la 0098 (PGRST202) → sin lease, como antes (con aviso)", () => {
  assertEquals(interpretDreamsClaim({ data: null, error: { code: "PGRST202", message: "x" } }), { kind: "unavailable" });
});

Deno.test("otro error → no analiza (no arriesga dos análisis en paralelo)", () => {
  assertEquals(interpretDreamsClaim({ data: null, error: { code: "57014", message: "timeout" } }).kind, "error");
});

Deno.test("el lease cubre el wall clock de una Edge Function", () => {
  assertEquals(DREAMS_LEASE_SECONDS >= 400, true);
});
