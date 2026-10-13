// Correr con: deno test --allow-read supabase/functions/_shared/alert-kinds.test.ts
// El registro de tipos de alerta, el default de webhook_kinds (0076) y lo que el código y el SQL
// realmente insertan tienen que decir lo MISMO.
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { ALERT_KINDS, shouldPostAlert, shouldSweep, webhookKindsDefault, type WebhookConfigLike } from "./alert-kinds.ts";

const root = new URL("../../", import.meta.url); // supabase/
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(u);
    else yield u;
  }
}

Deno.test("el default de webhook_kinds de 0076 es EXACTAMENTE el del registro (y dream_error no está)", () => {
  const sql = read("migrations/0076_alert_webhook_delivery.sql");
  const m = sql.match(/set default array\[([\s\S]*?)\]::text\[\]/);
  assert(m, "no se encontró el default de webhook_kinds");
  const kinds = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assertEquals(kinds, webhookKindsDefault());
  assert(!kinds.includes("dream_error"));
  assertEquals(ALERT_KINDS.dream_error.webhook, false);
  assert(ALERT_KINDS.dream_error.reason.includes("/dreams"));
});

Deno.test("los tipos nuevos de esta tanda están como notificables", () => {
  for (const k of ["salesbot_not_delivered", "provider_credit_exhausted", "webhook_rejected", "webhook_unsigned", "outbound_blocked", "inbound_dropped"]) {
    assertEquals(ALERT_KINDS[k]?.webhook, true, k);
  }
});

Deno.test("todo tipo que el código o el SQL insertan en `alerts` está en el registro", async () => {
  const found = new Map<string, string>(); // kind → archivo
  for await (const u of walk(new URL("functions/", root))) {
    if (!u.pathname.endsWith(".ts") || u.pathname.endsWith(".test.ts")) continue;
    const text = await Deno.readTextFile(u);
    const rel = u.pathname.slice(u.pathname.indexOf("/supabase/"));
    // 1) .from("alerts").insert({ ... kind: "x" ... }) (kind dentro de los siguientes 500 caracteres)
    for (const m of text.matchAll(/from\("alerts"\)\s*\.insert\(/g)) {
      const chunk = text.slice(m.index!, m.index! + 500);
      const k = chunk.match(/kind:\s*(?:"([a-z_]+)"|([A-Z_]+))/);
      if (k?.[1]) found.set(k[1], rel);
      if (k?.[2]) {
        const c = text.match(new RegExp(`${k[2]}\\s*=\\s*"([a-z_]+)"`));
        if (c) found.set(c[1], rel);
      }
    }
    // 2) detectores de alerts-scan / health-detectores: cada `kind: "x"` es un tipo de alerta/incidente
    if (/alerts-scan\/index\.ts$|health-detectores\.ts$/.test(u.pathname)) {
      for (const m of text.matchAll(/\bkind:\s*"([a-z_]+)"/g)) found.set(m[1], rel);
    }
  }
  for await (const u of walk(new URL("migrations/", root))) {
    const text = await Deno.readTextFile(u);
    for (const m of text.matchAll(/insert into alerts\s*\(\s*kind[\s\S]{0,400}?values\s*\(\s*'([a-z_]+)'/g)) {
      found.set(m[1], u.pathname.slice(u.pathname.indexOf("/supabase/")));
    }
  }
  assert(found.size >= 8, `el escaneo casi no encontró tipos (${found.size}): dejó de ver los inserts`);
  const missing = [...found].filter(([k]) => !(k in ALERT_KINDS));
  assertEquals(missing, [], `tipos de alerta sin registrar en _shared/alert-kinds.ts: ${missing.map(([k, f]) => `${k} (${f})`).join(", ")}`);
});

Deno.test("todo tipo del registro tiene motivo", () => {
  for (const [k, v] of Object.entries(ALERT_KINDS)) assert(v.reason.length > 20, k);
});

const CFG: WebhookConfigLike = { webhook_enabled: true, webhook_url: "https://hooks.example/x", webhook_kinds: webhookKindsDefault() };

Deno.test("shouldPostAlert / shouldSweep: sin webhook activo no se reclama ni se postea; el operador manda sobre los tipos", () => {
  assertEquals(shouldSweep(null), false);
  assertEquals(shouldSweep({ ...CFG, webhook_enabled: false }), false);
  assertEquals(shouldSweep({ ...CFG, webhook_url: null }), false);
  assertEquals(shouldSweep(CFG), true);
  assertEquals(shouldPostAlert({ kind: "salesbot_not_delivered" }, CFG), true);
  assertEquals(shouldPostAlert({ kind: "dream_error" }, CFG), false);
  // el operador quitó un tipo: no se postea aunque esté en el registro
  assertEquals(shouldPostAlert({ kind: "outbound_blocked" }, { ...CFG, webhook_kinds: ["draft_failed"] }), false);
  assertEquals(shouldPostAlert({ kind: "outbound_blocked" }, null), false);
});
