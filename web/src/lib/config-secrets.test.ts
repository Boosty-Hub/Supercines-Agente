// Clasificación de secretos de runtime_config, enmascarado, vistas que viajan al navegador,
// política de escritura por alcance y la decisión de alcance de las rutas.
// Correr con: cd web && node --test src/lib/config-secrets.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MASK_MIN_LENGTH,
  PUBLIC_CONFIG_KEYS,
  configEntryView,
  configKeysDenied,
  configView,
  isSecretConfigKey,
  maskSecret,
  secretInputAction,
} from "./config-secrets.ts";
import { setupStateFromConfig } from "./setup-state-view.ts";
import { authorizeScope, configWriterFor } from "./auth/scope-guard.ts";
import { SCOPES } from "./auth/roles.ts";

// Todas las credenciales que hoy viven (o pueden vivir) en runtime_config.
const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-zz91",
  KOMMO_ACCESS_TOKEN: "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.payload-largo.firma-kommo-7788",
  OPENAI_API_KEY: "sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB-4455",
  BCV_RATE_APIKEY: "bcv-key-CCCCCCCCCCCCCCCC-1122",
  BCV_RATE_URL: "https://api.ejemplo.com/rate?apikey=DDDDDDDDDDDD",
  SHOPIFY_ACCESS_TOKEN: "shpat_EEEEEEEEEEEEEEEEEEEEEEEE",
  SHOPIFY_CLIENT_ID: "client-id-FFFFFFFFFFFF",
  SHOPIFY_CLIENT_SECRET: "shpss_GGGGGGGGGGGGGGGGGGGGG",
  SUPABASE_ACCESS_TOKEN: "sbp_HHHHHHHHHHHHHHHHHHHHHHHHHHHH",
  TOOL_ERP: "erp-secreto-IIIIIIIIIIIIIIII",
  AI_PRICING_OVERRIDES: "{}",
};

test("las credenciales conocidas son secretas", () => {
  for (const k of Object.keys(SECRETS)) assert.equal(isSecretConfigKey(k), true, k);
});

test("DEFAULT SEGURO: una clave desconocida es secreta (olvidarse de clasificar falla cerrado)", () => {
  for (const k of ["FOO_API_KEY", "NUEVA_CLAVE", "TOOL_NUEVO", "X", "", "operator_name", "SYSTEM_PROMPT ", "__proto__"]) {
    assert.equal(isSecretConfigKey(k), true, JSON.stringify(k));
  }
});

test("lo público es la lista declarada (+ TOOL_<X>_HOSTS, que es un dato)", () => {
  for (const k of ["OPERATOR_NAME", "KOMMO_API_DOMAIN", "AGENT_MODEL", "MONTHLY_BUDGET_USD", "ANTHROPIC_AGENT_ID"]) {
    assert.equal(isSecretConfigKey(k), false, k);
  }
  assert.equal(isSecretConfigKey("TOOL_ERP_HOSTS"), false);
  assert.equal(isSecretConfigKey("TOOL_ERP"), true);
});

test("ninguna clave pública tiene forma de credencial", () => {
  for (const k of PUBLIC_CONFIG_KEYS) {
    assert.doesNotMatch(k, /KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID/, `${k} está en la lista pública`);
  }
});

test("maskSecret: últimos 4 solo si es largo; corto ⇒ nada; vacío ⇒ null", () => {
  assert.equal(maskSecret("sk-ant-api03-xxxxxxxxxxxxxxxx-zz91"), "••••zz91");
  assert.equal(maskSecret("a".repeat(MASK_MIN_LENGTH - 1)), "••••");
  assert.equal(maskSecret("12345678"), "••••");
  assert.equal(maskSecret("   "), null);
  assert.equal(maskSecret(""), null);
  assert.equal(maskSecret(null), null);
  assert.equal(maskSecret(undefined), null);
  // Nunca más de 4 caracteres reales.
  const m = maskSecret("x".repeat(200) + "1234")!;
  assert.equal(m.replace(/•/g, "").length, 4);
});

test("configView: NINGÚN valor secreto sale; los públicos sí", () => {
  const values = { ...SECRETS, OPERATOR_NAME: "Tienda Zeta", KOMMO_API_DOMAIN: "zeta.kommo.com" };
  const keys = Object.keys(values);
  const view = configView(values, keys);
  const json = JSON.stringify(view);
  for (const [k, v] of Object.entries(SECRETS)) {
    assert.ok(!json.includes(v), `${k} se filtró en la vista`);
    // ni un pedazo largo
    assert.ok(!json.includes(v.slice(0, 10)), `${k}: prefijo filtrado`);
    const e = view[k];
    assert.equal(e.secret, true);
  }
  assert.deepEqual(view.OPERATOR_NAME, { secret: false, value: "Tienda Zeta" });
  assert.deepEqual(configEntryView("ANTHROPIC_API_KEY", null), { secret: true, set: false, masked: null });
  assert.deepEqual(configEntryView("ANTHROPIC_API_KEY", SECRETS.ANTHROPIC_API_KEY), { secret: true, set: true, masked: "••••zz91" });
});

test("estado del setup (viaja al drawer, cliente): solo enmascarado, nunca el secreto", () => {
  const db: Record<string, string> = Object.assign(Object.create(null), SECRETS, {
    OPERATOR_NAME: "Tienda Zeta",
    KOMMO_SUBDOMAIN: "zeta",
    ANTHROPIC_AGENT_ID: "agent_123",
    ANTHROPIC_MEMORY_MASTER_ID: "memstore_a",
    ANTHROPIC_MEMORY_LEADS_ID: "memstore_b",
  });
  const state = setupStateFromConfig(db);
  const json = JSON.stringify(state);
  for (const [k, v] of Object.entries(SECRETS)) assert.ok(!json.includes(v), `${k} se filtró al estado del setup`);
  assert.equal(state.credentialsDone, true);
  assert.equal(state.kommoDone, true);
  assert.equal(state.memoryDone, true);
  assert.equal(state.secrets.anthropicApiKey, "••••zz91");
  assert.equal(state.secrets.kommoAccessToken, "••••7788");
  assert.equal(state.prefill.operatorName, "Tienda Zeta");
  const empty = setupStateFromConfig(Object.create(null));
  assert.equal(empty.credentialsDone, false);
  assert.deepEqual(empty.secrets, { anthropicApiKey: null, kommoAccessToken: null });
});

test("escritura: configuracion todo; contenido solo la política de Dreams; operacion nada", () => {
  assert.deepEqual(configKeysDenied("configuracion", ["ANTHROPIC_API_KEY", "SYSTEM_PROMPT", "TOOL_X_HOSTS"]), []);
  assert.deepEqual(configKeysDenied("contenido", ["DREAMS_AUTO_ACTIVATE", "DREAMS_FREQUENCY"]), []);
  // Reactivar Dreams desde /dreams registra el momento (frequencyChangeValues).
  assert.deepEqual(configKeysDenied("contenido", ["DREAMS_FREQUENCY", "DREAMS_RESUMED_AT"]), []);
  assert.deepEqual(configKeysDenied("contenido", ["DREAMS_FREQUENCY", "KOMMO_API_DOMAIN"]), ["KOMMO_API_DOMAIN"]);
  assert.deepEqual(configKeysDenied("contenido", ["ANTHROPIC_API_KEY"]), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(configKeysDenied("operacion", ["DREAMS_FREQUENCY", "OPERATOR_NAME"]), ["DREAMS_FREQUENCY", "OPERATOR_NAME"]);
});

test("input de secreto: vacío conserva, valor reemplaza, «quitar» borra (nunca se rellena con el actual)", () => {
  assert.deepEqual(secretInputAction("", false), { action: "keep" });
  assert.deepEqual(secretInputAction("   ", false), { action: "keep" });
  assert.deepEqual(secretInputAction(undefined, false), { action: "keep" });
  assert.deepEqual(secretInputAction(" https://hooks.slack.com/x ", false), { action: "set", value: "https://hooks.slack.com/x" });
  assert.deepEqual(secretInputAction("https://hooks.slack.com/x", true), { action: "clear" });
});

// ── Alcance de las rutas (lógica pura de require-scope) ─────────────────────────────
const user = (role?: unknown) => ({ email: "a@b.c", app_metadata: role === undefined ? {} : { role } });

test("authorizeScope: sin sesión 401; operacion/contenido 403 en config; configuracion ok", () => {
  assert.deepEqual(authorizeScope(null, "configuracion"), { ok: false, status: 401, error: "unauthorized" });
  for (const role of ["operacion", "contenido", "editor", "Admin ", "root"]) {
    const d = authorizeScope(user(role), "configuracion");
    assert.equal(d.ok, false, String(role));
    if (!d.ok) assert.equal(d.status, 403);
  }
  for (const role of ["configuracion", "admin"]) {
    const d = authorizeScope(user(role), "configuracion");
    assert.equal(d.ok, true, String(role));
  }
  // Sin rol = SIN ACCESO: 403 incluso para el alcance más bajo (antes era configuracion).
  for (const role of [undefined, null, ""]) {
    for (const req of SCOPES) {
      const d = authorizeScope(user(role), req);
      assert.equal(d.ok, false, `${String(role)} → ${req}`);
      if (!d.ok) {
        assert.equal(d.status, 403);
        assert.equal(d.sinAcceso, true);
      }
    }
  }
  assert.equal(authorizeScope(user("contenido"), "contenido").ok, true);
  assert.equal(authorizeScope(user("operacion"), "contenido").ok, false);
  assert.equal(authorizeScope(user("operacion"), "operacion").ok, true);
});

test("operacion/contenido no pueden escribir ni ver secretos con el escritor que les da su sesión", () => {
  for (const scope of SCOPES) {
    const d = authorizeScope(user(scope), scope);
    assert.equal(d.ok, true);
    if (!d.ok) continue;
    const w = configWriterFor(user(scope), d.scope);
    const denied = configKeysDenied(w.scope, ["ANTHROPIC_API_KEY", "KOMMO_API_DOMAIN", "TOOL_X_HOSTS", "SYSTEM_PROMPT"]);
    if (scope === "configuracion") assert.deepEqual(denied, []);
    else assert.equal(denied.length, 4, scope);
  }
  assert.deepEqual(configWriterFor(user("configuracion"), "configuracion"), { by: "a@b.c", scope: "configuracion" });
  assert.deepEqual(configWriterFor({ app_metadata: {} }, "configuracion"), { by: "dashboard", scope: "configuracion" });
});
