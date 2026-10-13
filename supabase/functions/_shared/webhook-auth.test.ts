// Correr con: deno test --node-modules-dir=auto --allow-read --allow-env supabase/functions/_shared/webhook-auth.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  authorizeWebhook,
  AUTH_WAIT_MS,
  BAD_TOKEN_RECHECK_MS,
  decideWebhook,
  extractToken,
  loadWebhookAuthState,
  NEGATIVE_TTL_MS,
  noteWebhookRequest,
  resetWebhookAuthCache,
  resetWebhookNoteThrottle,
  TTL_MS,
  type WebhookAuthState,
} from "./webhook-auth.ts";

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

Deno.test("un secreto incorrecto se rechaza SIEMPRE (también en modo permisivo)", () => {
  assertEquals(decideWebhook("otro", permissive).allow, false);
  assertEquals(decideWebhook("otro", strict).allow, false);
  assertEquals(decideWebhook(S + "x", strict).reason, "bad_token");
  assertEquals(decideWebhook(S.slice(0, -1), strict).reason, "bad_token");
});

Deno.test("sin secreto: permisivo acepta (transición), estricto rechaza", () => {
  assertEquals(decideWebhook(null, permissive), { allow: true, signed: false, reason: "unsigned_permissive" });
  assertEquals(decideWebhook(null, strict), { allow: false, signed: false, reason: "unsigned_strict" });
});

Deno.test("fail-open: sin estado legible o sin secreto configurado NO se apaga el webhook", () => {
  assertEquals(decideWebhook(null, null).allow, true);
  assertEquals(decideWebhook("lo-que-sea", null).allow, true);
  assertEquals(decideWebhook(null, { mode: "strict", secrets: [] }).allow, true);
});

Deno.test("rotación: el anterior y el legado valen pero NO cuentan como el vigente", () => {
  const st: WebhookAuthState = { mode: "strict", secrets: ["nuevo", "viejo", "env"], current: "nuevo" };
  for (const t of ["nuevo", "viejo", "env"]) assertEquals(decideWebhook(t, st).signed, true);
  assertEquals(decideWebhook("nuevo", st).current, true);
  assertEquals(decideWebhook("viejo", st).current, false);
  assertEquals(decideWebhook("env", st).current, false);
  assertEquals(decideWebhook("otro", st).allow, false);
});

// ---- Cliente falso: cuenta consultas y deja controlar cuándo/cómo responde ----
type Tables = Record<string, unknown>;
type Mode = { kind: "ok"; tables: Tables } | { kind: "fail" } | { kind: "hang" };

// deno-lint-ignore no-explicit-any
function fakeClient(initial: Mode): { sb: any; set: (m: Mode) => void; queries: () => number } {
  let mode = initial;
  let n = 0;
  const answer = (t: string) => {
    if (mode.kind === "hang") return new Promise(() => {}); // nunca resuelve
    if (mode.kind === "fail") return Promise.resolve({ data: null, error: { message: "relation does not exist" } });
    return Promise.resolve({ data: mode.tables[t], error: null });
  };
  return {
    set: (m) => (mode = m),
    queries: () => n,
    sb: {
      from(t: string) {
        if (t === "kommo_webhook_auth") n++; // una "carga" = un par de consultas
        // deno-lint-ignore no-explicit-any
        const q: any = {
          select: () => q,
          in: () => q,
          eq: () => q,
          maybeSingle: () => answer(t),
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => answer(t).then(res, rej),
        };
        return q;
      },
    },
  };
}

const tablesWith = (current: string, mode = "strict", previous?: string, prevExp?: string): Tables => ({
  _app_secrets: [
    { clave: "KOMMO_WEBHOOK_SECRET", valor: current },
    ...(previous ? [{ clave: "KOMMO_WEBHOOK_SECRET_PREVIOUS", valor: previous }] : []),
  ],
  kommo_webhook_auth: { mode, previous_expires_at: prevExp ?? null },
});

/** Reloj manual + colector de trabajo en segundo plano (se espera al final: sin fugas de timers). */
function harness(start = 1_000_000) {
  let t = start;
  const bg: Promise<unknown>[] = [];
  return {
    opts: { now: () => t, background: (p: Promise<unknown>) => void bg.push(p) },
    advance: (ms: number) => (t += ms),
    drain: () => Promise.allSettled(bg),
  };
}

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

Deno.test("A-C1: con la base COLGADA el webhook decide en < 1 s (fail-open) y no espera de nuevo", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "hang" });
  const bg: Promise<unknown>[] = [];
  const opts = { background: (p: Promise<unknown>) => void bg.push(p), fetchTimeoutMs: 1_200 };
  const t0 = performance.now();
  const d = await authorizeWebhook(c.sb, null, "", opts);
  const ms = performance.now() - t0;
  assert(ms < 1_000, `tardó ${ms} ms`);
  assert(ms >= AUTH_WAIT_MS - 50, `no esperó el tope (${ms} ms)`);
  assertEquals(d, { allow: true, signed: false, reason: "state_unavailable" });
  // La siguiente request, dentro del caché negativo, ni siquiera espera.
  const t1 = performance.now();
  await authorizeWebhook(c.sb, "x", "", opts);
  assert(performance.now() - t1 < 50);
  assertEquals(c.queries(), 1);
  await Promise.allSettled(bg); // la consulta colgada vence por su techo duro (sin fugas)
});

Deno.test("A-C1: una ráfaga concurrente comparte UNA sola consulta", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "ok", tables: tablesWith(S) });
  const h = harness();
  const ds = await Promise.all(Array.from({ length: 50 }, () => authorizeWebhook(c.sb, S, "", h.opts)));
  assertEquals(c.queries(), 1);
  assert(ds.every((d) => d.allow && d.signed));
  // Dentro del TTL no se vuelve a consultar.
  h.advance(TTL_MS - 1);
  await authorizeWebhook(c.sb, S, "", h.opts);
  assertEquals(c.queries(), 1);
  await h.drain();
});

Deno.test("A-C1: caché NEGATIVO — con 0070 sin aplicar no se consulta en cada request", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "fail" });
  const h = harness();
  for (let i = 0; i < 20; i++) assertEquals((await authorizeWebhook(c.sb, null, "", h.opts)).allow, true);
  assertEquals(c.queries(), 1);
  h.advance(NEGATIVE_TTL_MS + 1);
  await authorizeWebhook(c.sb, null, "", h.opts);
  assertEquals(c.queries(), 2);
  await h.drain();
});

Deno.test("A-C1: stale-while-revalidate — vencido se responde YA con el viejo y se refresca atrás", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "ok", tables: tablesWith(S, "permissive") });
  const h = harness();
  await loadWebhookAuthState(c.sb, "", h.opts);
  h.advance(TTL_MS + 1);
  c.set({ kind: "hang" });
  const t0 = performance.now();
  const st = await loadWebhookAuthState(c.sb, "", { ...h.opts, fetchTimeoutMs: 50 });
  assert(performance.now() - t0 < 50, "no debe esperar a la base con un caché vencido");
  assertEquals(st?.mode, "permissive");
  assertEquals(c.queries(), 2);
  await h.drain();
  // La base cae: se sigue sirviendo el último estado conocido (no fail-open a ciegas).
  assertEquals((await loadWebhookAuthState(c.sb, "", h.opts))?.secrets, [S]);
});

Deno.test("A-W1: tras rotar, el token NUEVO en una instancia caliente se acepta (recarga una vez)", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "ok", tables: tablesWith("S0", "strict") });
  const h = harness();
  assertEquals((await authorizeWebhook(c.sb, "S0", "", h.opts)).allow, true);
  // Se rota en la base (S1 vigente, S0 anterior); el caché de esta instancia sigue con S0.
  c.set({ kind: "ok", tables: tablesWith("S1", "strict", "S0", "2099-01-01T00:00:00Z") });
  h.advance(BAD_TOKEN_RECHECK_MS + 1);
  const d = await authorizeWebhook(c.sb, "S1", "", h.opts);
  assertEquals(d, { allow: true, signed: true, current: true, reason: "ok" });
  assertEquals(c.queries(), 2);
  await h.drain();
});

Deno.test("A-W1: un token falso no fuerza recargas en cada request (caché reciente, ráfagas deduplicadas)", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "ok", tables: tablesWith(S, "strict") });
  const h = harness();
  await authorizeWebhook(c.sb, S, "", h.opts);
  // Caché reciente (< BAD_TOKEN_RECHECK_MS): rechaza sin consultar.
  assertEquals((await authorizeWebhook(c.sb, "falso", "", h.opts)).reason, "bad_token");
  assertEquals(c.queries(), 1);
  // Caché "viejo": una ráfaga de tokens falsos comparte UNA recarga, y después el caché es fresco.
  h.advance(BAD_TOKEN_RECHECK_MS + 1);
  const ds = await Promise.all(Array.from({ length: 30 }, () => authorizeWebhook(c.sb, "falso", "", h.opts)));
  assert(ds.every((d) => !d.allow && d.reason === "bad_token"));
  assertEquals(c.queries(), 2);
  await authorizeWebhook(c.sb, "falso", "", h.opts);
  assertEquals(c.queries(), 2);
  await h.drain();
});

Deno.test("A-W1: si la recarga no llega a tiempo, un token incorrecto se rechaza igual (y en < 1 s)", async () => {
  resetWebhookAuthCache();
  const c = fakeClient({ kind: "ok", tables: tablesWith(S, "strict") });
  const bg: Promise<unknown>[] = [];
  let t = 1_000_000;
  const opts = { now: () => t, background: (p: Promise<unknown>) => void bg.push(p), fetchTimeoutMs: 1_200 };
  await authorizeWebhook(c.sb, S, "", opts);
  c.set({ kind: "hang" });
  t += BAD_TOKEN_RECHECK_MS + 1;
  const t0 = performance.now();
  const d = await authorizeWebhook(c.sb, "falso", "", opts);
  assert(performance.now() - t0 < 1_000);
  assertEquals(d.reason, "bad_token");
  await Promise.allSettled(bg);
});

Deno.test("noteWebhookRequest: estrangulado por tipo; informa si el token es el VIGENTE; strict vence el caché", async () => {
  resetWebhookNoteThrottle();
  const calls: unknown[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = { rpc: (_f: string, args: unknown) => { calls.push(args); return Promise.resolve({ data: "strict", error: null }); } };
  await noteWebhookRequest(sb, false, 1_000_000);
  await noteWebhookRequest(sb, false, 1_000_000 + 30_000);
  await noteWebhookRequest(sb, true, 1_000_000 + 30_000, true); // otro tipo: no está estrangulado
  await noteWebhookRequest(sb, true, 1_000_000 + 30_000, false); // firmado con el anterior: otro tipo
  assertEquals(calls, [
    { p_signed: false, p_current: false },
    { p_signed: true, p_current: true },
    { p_signed: true, p_current: false },
  ]);
  await noteWebhookRequest(sb, false, 1_000_000 + 61_000);
  assertEquals(calls.length, 4);
  // un fallo de la base no rompe el webhook
  // deno-lint-ignore no-explicit-any
  const bad: any = { rpc: () => Promise.reject(new Error("x")) };
  resetWebhookNoteThrottle();
  await noteWebhookRequest(bad, false, 5);
});
