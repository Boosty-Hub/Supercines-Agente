// Correr con: deno test --node-modules-dir=auto --allow-read --allow-env supabase/functions/_shared/webhook-auth.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  decideWebhook,
  extractToken,
  loadWebhookAuthState,
  noteWebhookRequest,
  resetWebhookAuthCache,
  resetWebhookNoteThrottle,
  type WebhookAuthState,
} from "./webhook-auth.ts";

const S = "s3cret-abc";
const permissive: WebhookAuthState = { mode: "permissive", secrets: [S] };
const strict: WebhookAuthState = { mode: "strict", secrets: [S] };

Deno.test("extractToken: ?token= canónico, ?secret= legado y header", () => {
  assertEquals(extractToken(new URL("https://x/f?token=a"), new Headers()), "a");
  assertEquals(extractToken(new URL("https://x/f?secret=b"), new Headers()), "b");
  assertEquals(extractToken(new URL("https://x/f"), new Headers({ "x-webhook-secret": "c" })), "c");
  assertEquals(extractToken(new URL("https://x/f?token="), new Headers()), null);
  assertEquals(extractToken(new URL("https://x/f"), new Headers()), null);
});

Deno.test("con el secreto correcto se acepta firmado, en ambos modos", () => {
  assertEquals(decideWebhook(S, permissive), { allow: true, signed: true, reason: "ok" });
  assertEquals(decideWebhook(S, strict), { allow: true, signed: true, reason: "ok" });
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

Deno.test("rotación: el secreto anterior y el legado de env también valen", () => {
  const st: WebhookAuthState = { mode: "strict", secrets: ["nuevo", "viejo", "env"] };
  for (const t of ["nuevo", "viejo", "env"]) assertEquals(decideWebhook(t, st).signed, true);
  assertEquals(decideWebhook("otro", st).allow, false);
});

// ---- loadWebhookAuthState con un cliente falso ----
// deno-lint-ignore no-explicit-any
function fakeClient(tables: Record<string, any>, fail = false): any {
  return {
    from(t: string) {
      const q: any = {
        select: () => q,
        in: () => q,
        eq: () => q,
        maybeSingle: () => Promise.resolve({ data: tables[t], error: fail ? { message: "caído" } : null }),
        then: (res: (v: unknown) => unknown) => res({ data: tables[t], error: fail ? { message: "caído" } : null }),
      };
      return q;
    },
  };
}

Deno.test("loadWebhookAuthState: arma los secretos vigentes y descarta el anterior vencido", async () => {
  resetWebhookAuthCache();
  const now = Date.parse("2026-10-13T12:00:00Z");
  const sb = fakeClient({
    _app_secrets: [
      { clave: "KOMMO_WEBHOOK_SECRET", valor: "n" },
      { clave: "KOMMO_WEBHOOK_SECRET_PREVIOUS", valor: "p" },
    ],
    kommo_webhook_auth: { mode: "strict", previous_expires_at: "2026-10-12T12:00:00Z" },
  });
  assertEquals(await loadWebhookAuthState(sb, "", now), { mode: "strict", secrets: ["n"] });
  resetWebhookAuthCache();
  const sb2 = fakeClient({
    _app_secrets: [{ clave: "KOMMO_WEBHOOK_SECRET", valor: "n" }, { clave: "KOMMO_WEBHOOK_SECRET_PREVIOUS", valor: "p" }],
    kommo_webhook_auth: { mode: "permissive", previous_expires_at: "2026-10-14T12:00:00Z" },
  });
  assertEquals(await loadWebhookAuthState(sb2, "legacy", now), { mode: "permissive", secrets: ["n", "p", "legacy"] });
});

Deno.test("loadWebhookAuthState: si la base falla devuelve null (fail-open) o el último estado conocido", async () => {
  resetWebhookAuthCache();
  assertEquals(await loadWebhookAuthState(fakeClient({}, true), "", 1), null);
});

Deno.test("noteWebhookRequest: estrangulado a una llamada por minuto y tipo; strict descarta el caché", async () => {
  resetWebhookNoteThrottle();
  let calls = 0;
  // deno-lint-ignore no-explicit-any
  const sb: any = { rpc: () => { calls++; return Promise.resolve({ data: "strict", error: null }); } };
  await noteWebhookRequest(sb, false, 1_000_000);
  await noteWebhookRequest(sb, false, 1_000_000 + 30_000);
  await noteWebhookRequest(sb, true, 1_000_000 + 30_000); // otro tipo: no está estrangulado
  assertEquals(calls, 2);
  await noteWebhookRequest(sb, false, 1_000_000 + 61_000);
  assertEquals(calls, 3);
  // un fallo de la base no rompe el webhook
  // deno-lint-ignore no-explicit-any
  const bad: any = { rpc: () => Promise.reject(new Error("x")) };
  resetWebhookNoteThrottle();
  await noteWebhookRequest(bad, false, 5);
  assert(true);
});
