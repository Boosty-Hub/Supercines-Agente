// _shared/backfill-claim.test.ts
// La base decide (ver supabase/tests/claim_kommo_backfill.sql); acá se prueba que
// cada resultado del claim se traduzca al estado correcto y que SOLO 'started' /
// 'continuing' den permiso de recorrer Kommo.

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { interpretClaim, type ClaimRow } from "./backfill-claim.ts";

const row = (outcome: string, extra: Partial<ClaimRow> = {}): ClaimRow => ({
  outcome,
  status: "running",
  next_page: 7,
  scanned: 1500,
  updated: 40,
  retry_after_seconds: null,
  lease_token: "tok-1",
  ...extra,
});

Deno.test("interpretClaim: restarted → started, corre desde el cursor que devolvió la base", () => {
  assertEquals(interpretClaim(row("restarted", { next_page: 1, scanned: 0, updated: 0 })), {
    state: "started",
    run: { nextPage: 1, scanned: 0, updated: 0, leaseToken: "tok-1" },
    retryAfterSeconds: null,
  });
});

Deno.test("interpretClaim: claimed → continuing, conserva el progreso (nunca rebobina)", () => {
  assertEquals(interpretClaim(row("claimed")), {
    state: "continuing",
    run: { nextPage: 7, scanned: 1500, updated: 40, leaseToken: "tok-1" },
    retryAfterSeconds: null,
  });
});

Deno.test("interpretClaim: busy, cooldown, done y desconocido NO recorren Kommo", () => {
  for (const outcome of ["busy", "cooldown", "done", "missing", "algo-raro"]) {
    assertEquals(interpretClaim(row(outcome)).run, null, outcome);
  }
  assertEquals(interpretClaim(row("busy")).state, "busy");
  assertEquals(interpretClaim(row("done")).state, "idle");
  assertEquals(interpretClaim(row("missing")).state, "unavailable");
});

Deno.test("interpretClaim: cooldown informa cuánto falta", () => {
  assertEquals(interpretClaim(row("cooldown", { retry_after_seconds: 421 })), {
    state: "cooldown",
    run: null,
    retryAfterSeconds: 421,
  });
});

Deno.test("interpretClaim: sin fila (RPC vacío) → unavailable", () => {
  assertEquals(interpretClaim(undefined).state, "unavailable");
  assertEquals(interpretClaim(null).run, null);
});

Deno.test("interpretClaim: claimed/restarted SIN lease_token → unavailable (no se recorre sin poder probar que es el dueño)", () => {
  for (const outcome of ["claimed", "restarted"]) {
    const d = interpretClaim(row(outcome, { lease_token: null }));
    assertEquals(d.state, "unavailable", outcome);
    assertEquals(d.run, null, outcome);
  }
});
