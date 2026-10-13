// Correr con: deno test --node-modules-dir=auto --allow-read --allow-env supabase/functions/_shared/webhook-auth.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  authorizeWebhook,
  BAD_TOKEN_RECHECK_MS,
  decideWebhook,
  extractToken,
  loadWebhookAuthState,
  NEGATIVE_TTL_MS,
  noteKindFor,
  noteWebhookRequest,
  resetWebhookAuthCache,
  resetWebhookNoteThrottle,
  TTL_MS,
  type WebhookAuthState,
} from "./webhook-auth.ts";
import { fakeClient, harness, tablesWith } from "./webhook-test-fakes.ts";

const S = "s3cret-abc";
const permissive: WebhookAuthState = { mode: "permissive", secrets: [S], current: S };
const strict: WebhookAuthState = { mode: "strict", secrets: [S], current: S };

Deno.test("extractToken: ?token= canónico, ?secret= legado y header", () => {
  assertEquals(extractToken(new URL("https://x/f?token=a"), new Headers()), "a");
  assertEquals(extractToken(new URL("https://x/f?secret=b"), new Headers()), "b");
  assertEquals(extractToken(new URL("https://x/f"), new Headers({ "x-webhook-secret": "c" })), "c");
  assertEquals(extractToken(new URL("https://x/f?token="), new Headers()), null);
  assertEquals(extractToken(new URL("https://x/f"), new Headers()), null);
});

Deno.test("con el secreto correcto se acepta firmado, en ambos modos", () => {
  assertEquals(decideWebhook(S, permissive), { allow: true, signed: true, current: true, reason: "ok" });
  assertEquals(decideWebhook(S, strict), { allow: true, signed: true, current: true, reason: "ok" });
});

Deno.test("un secreto incorrecto se descarta SIEMPRE (también en modo permisivo)", () => {
  assertEquals(decideWebhook("otro", permissive).allow, false);
  assertEquals(decideWebhook("otro", strict).allow, false);
  assertEquals(decideWebhook(S + "x", strict).reason, "bad_token");
  assertEquals(decideWebhook(S.slice(0, -1), strict).reason, "bad_token");
});

Deno.test("sin secreto: permisivo acepta (transición), estricto descarta", () => {
  assertEquals(decideWebhook(null, permissive), { allow: true, signed: false, reason: "unsigned_permissive" });
  assertEquals(decideWebhook(null, strict), { allow: false, signed: false, reason: "unsigned_strict" });
});

Deno.test("SIN fail-open: sin estado no se acepta nada; sin secretos rige el modo", () => {
  assertEquals(decideWebhook(null, null), { allow: false, signed: false, reason: "state_unavailable" });
  assertEquals(decideWebhook("lo-que-sea", null).allow, false);
  assertEquals(decideWebhook(null, { mode: "strict", secrets: [] }).allow, false);
  assertEquals(decideWebhook(null, { mode: "permissive", secrets: [] }).reason, "no_secret_configured");
});

Deno.test("rotación: el anterior y el legado valen pero NO cuentan como el vigente", () => {
  const st: WebhookAuthState = { mode: "strict", secrets: ["nuevo", "viejo", "env"], current: "nuevo" };
  for (const t of ["nuevo", "viejo", "env"]) assertEquals(decideWebhook(t, st).signed, true);
  assertEquals(decideWebhook("nuevo", st).current, true);
  assertEquals(decideWebhook("viejo", st).current, false);
  assertEquals(decideWebhook("env", st).current, false);
  assertEquals(decideWebhook("otro", st).allow, false);
});

Deno.test("loadWebhookAuthState: arma los secretos vigentes y descarta el anterior vencido", async () => {
  resetWebhookAuthCache();
  const now = Date.parse("2026-10-13T12:00:00Z");
  const h = { now: () => now, background: () => {} };
  const a = fakeClient({ kind: "ok", tables: tablesWith("n", "strict", "p", "2026-10-12T12:00:00Z") });
  assertEquals(await loadWebhookAuthState(a.sb, "", h), { mode: "strict", secrets: ["n"], current: "n" });
  resetWebhookAuthCache();
  const b = fakeClient({ kind: "ok", tables: tablesWith("n", "permissive", "p", "2026-10-14T12:00:00Z") });
  assertEquals(await loadWebhookAuthState(b.sb, "legacy", h), {
    mode: "permissive",
    secrets: ["n", "p", "legacy"],
    current: "n",
  });
});

Deno.test("0070 sin aplicar (tabla inexistente) es un estado CONOCIDO: transición sin secretos, cacheado", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "missing" });
  const h = harness();
  for (let i = 0; i < 5; i++) {
    assertEquals(await authorizeWebhook(c.sb, null, "", h.opts), { allow: true, signed: false, reason: "no_secret_configured" });
  }
  assertEquals(c.queries(), 1);
  await h.drain();
});

Deno.test("una ráfaga concurrente comparte UNA sola consulta; dentro del TTL no se reconsulta", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "ok", tables: tablesWith(S) });
  const h = harness();
  const ds = await Promise.all(Array.from({ length: 50 }, () => authorizeWebhook(c.sb, S, "", h.opts)));
  assertEquals(c.queries(), 1);
  assert(ds.every((d) => d.allow && d.signed));
  h.advance(TTL_MS - 1);
  await authorizeWebhook(c.sb, S, "", h.opts);
  assertEquals(c.queries(), 1);
  await h.drain();
});

Deno.test("caché NEGATIVO: con la base fallando, las esperas comparten un intento por ventana y se rinden al plazo", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "fail" });
  const h = harness();
  const ds = await Promise.all(
    Array.from({ length: 20 }, () => authorizeWebhook(c.sb, null, "", { ...h.opts, deadlineMs: 3 * NEGATIVE_TTL_MS })),
  );
  assert(ds.every((d) => !d.allow && d.reason === "state_unavailable"));
  // Un intento inicial + uno por ventana negativa dentro del plazo (no 20 × N).
  assert(c.queries() >= 3 && c.queries() <= 4, `consultas: ${c.queries()}`);
  await h.drain();
});

Deno.test("estado nunca conocido: si la base vuelve dentro del plazo, se decide con el estado REAL", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "fail" });
  const h = harness();
  h.onSleep(() => c.set({ kind: "ok", tables: tablesWith(S, "strict") }));
  assertEquals((await authorizeWebhook(c.sb, null, "", h.opts)).reason, "unsigned_strict");
  assertEquals((await authorizeWebhook(c.sb, S, "", h.opts)).allow, true);
  await h.drain();
});

Deno.test("stale-while-revalidate: vencido se usa el viejo (último conocido) y se refresca atrás", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "ok", tables: tablesWith(S, "strict") });
  const h = harness();
  await loadWebhookAuthState(c.sb, "", h.opts);
  h.advance(TTL_MS + 1);
  c.set({ kind: "hang" });
  const t0 = performance.now();
  const st = await loadWebhookAuthState(c.sb, "", { ...h.opts, fetchTimeoutMs: 50 });
  assert(performance.now() - t0 < 50, "no debe esperar a la base con un caché vencido");
  assertEquals(st?.mode, "strict");
  assertEquals(c.queries(), 2);
  await h.drain();
  // La base sigue caída: estricto sigue rigiendo con el último estado conocido.
  assertEquals((await authorizeWebhook(c.sb, null, "", h.opts)).reason, "unsigned_strict");
});

Deno.test("A-W1: tras rotar, el token NUEVO en una instancia caliente se acepta (recarga una vez)", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "ok", tables: tablesWith("S0", "strict") });
  const h = harness();
  assertEquals((await authorizeWebhook(c.sb, "S0", "", h.opts)).allow, true);
  c.set({ kind: "ok", tables: tablesWith("S1", "strict", "S0", "2099-01-01T00:00:00Z") });
  h.advance(BAD_TOKEN_RECHECK_MS + 1);
  assertEquals(await authorizeWebhook(c.sb, "S1", "", h.opts), { allow: true, signed: true, current: true, reason: "ok" });
  assertEquals(c.queries(), 2);
  await h.drain();
});

Deno.test("A-W1: un token falso no fuerza recargas en cada request (caché reciente, ráfagas deduplicadas)", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "ok", tables: tablesWith(S, "strict") });
  const h = harness();
  await authorizeWebhook(c.sb, S, "", h.opts);
  assertEquals((await authorizeWebhook(c.sb, "falso", "", h.opts)).reason, "bad_token");
  assertEquals(c.queries(), 1);
  h.advance(BAD_TOKEN_RECHECK_MS + 1);
  const ds = await Promise.all(Array.from({ length: 30 }, () => authorizeWebhook(c.sb, "falso", "", h.opts)));
  assert(ds.every((d) => !d.allow && d.reason === "bad_token"));
  assertEquals(c.queries(), 2);
  await authorizeWebhook(c.sb, "falso", "", h.opts);
  assertEquals(c.queries(), 2);
  await h.drain();
});

Deno.test("noteKindFor: vigente / otro firmado / sin firma / descarte; estado ilegible no se registra", () => {
  assertEquals(noteKindFor({ allow: true, signed: true, current: true, reason: "ok" }), "current");
  assertEquals(noteKindFor({ allow: true, signed: true, current: false, reason: "ok" }), "signed");
  assertEquals(noteKindFor({ allow: true, signed: false, reason: "unsigned_permissive" }), "unsigned");
  assertEquals(noteKindFor({ allow: false, signed: false, reason: "bad_token" }), "rejected");
  assertEquals(noteKindFor({ allow: false, signed: false, reason: "state_unavailable" }), null);
});

Deno.test("noteWebhookRequest: estrangulado por tipo; informa vigente y motivo del descarte", async () => {
  resetWebhookNoteThrottle();
  const calls: unknown[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = { rpc: (_f: string, args: unknown) => { calls.push(args); return Promise.resolve({ data: "strict", error: null }); } };
  const T = 1_000_000;
  await noteWebhookRequest(sb, { allow: true, signed: false, reason: "unsigned_permissive" }, T);
  await noteWebhookRequest(sb, { allow: true, signed: false, reason: "unsigned_permissive" }, T + 30_000);
  await noteWebhookRequest(sb, { allow: true, signed: true, current: true, reason: "ok" }, T + 30_000);
  await noteWebhookRequest(sb, { allow: true, signed: true, current: false, reason: "ok" }, T + 30_000);
  await noteWebhookRequest(sb, { allow: false, signed: false, reason: "bad_token" }, T + 30_000);
  await noteWebhookRequest(sb, { allow: false, signed: false, reason: "unsigned_strict" }, T + 31_000);
  assertEquals(calls, [
    { p_signed: false, p_current: false, p_rejected: null },
    { p_signed: true, p_current: true, p_rejected: null },
    { p_signed: true, p_current: false, p_rejected: null },
    { p_signed: false, p_current: false, p_rejected: "bad_token" },
  ]);
  await noteWebhookRequest(sb, { allow: true, signed: false, reason: "unsigned_permissive" }, T + 61_000);
  assertEquals(calls.length, 5);
  // un fallo de la base no rompe nada
  // deno-lint-ignore no-explicit-any
  const bad: any = { rpc: () => Promise.reject(new Error("x")) };
  resetWebhookNoteThrottle();
  await noteWebhookRequest(bad, { allow: true, signed: false, reason: "unsigned_permissive" }, 5);
});
