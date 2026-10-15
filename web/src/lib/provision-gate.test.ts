// /api/provision/*: quién puede (primer arranque vs. sesión configuracion), con qué token, sobre
// qué proyecto, y el cierre del registro público al crear el maestro.
// Correr con: cd web && node --test src/lib/provision-gate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  legacySinRolPermitido,
  masterUserId,
  pendingFunctionSlugs,
  pickProvisionToken,
  provisionNeedsSession,
  provisionRef,
} from "./provision/gate-logic.ts";
import { lockPublicSignup } from "./provision/signup-lock.ts";

test("sin usuarios = primer arranque (sin sesión); con usuarios hace falta sesión; sin poder contar, cerrado", () => {
  assert.deepEqual(provisionNeedsSession(0), { ok: true, mode: "first-boot" });
  assert.equal(provisionNeedsSession(1), "check-session");
  assert.equal(provisionNeedsSession(250), "check-session");
  const d = provisionNeedsSession(null);
  assert.equal(d !== "check-session" && !d.ok && d.status, 503);
});

test("token: primer arranque SOLO el del body; con sesión el del body o el guardado", () => {
  assert.deepEqual(pickProvisionToken("first-boot", " sbp_body ", "sbp_stored"), { ok: true, token: "sbp_body" });
  assert.equal(pickProvisionToken("first-boot", undefined, "sbp_stored").ok, false);
  assert.equal(pickProvisionToken("first-boot", "", "sbp_stored").ok, false);
  assert.equal(pickProvisionToken("first-boot", 123, "sbp_stored").ok, false);
  assert.deepEqual(pickProvisionToken("session", undefined, "sbp_stored"), { ok: true, token: "sbp_stored" });
  assert.deepEqual(pickProvisionToken("session", "sbp_body", "sbp_stored"), { ok: true, token: "sbp_body" });
  assert.equal(pickProvisionToken("session", undefined, null).ok, false);
});

test("el ref sale SIEMPRE de la URL del despliegue", () => {
  assert.equal(provisionRef("https://abcxyz123.supabase.co"), "abcxyz123");
  assert.equal(provisionRef("https://abcxyz123.supabase.co/"), "abcxyz123");
  assert.throws(() => provisionRef("no-es-una-url"));
});

test("funciones pendientes: faltantes en vivo o sin el hash de esta versión, en el orden del bundle", () => {
  const bundle = [
    { slug: "a", hash: "1" },
    { slug: "b", hash: "2" },
    { slug: "c", hash: "3" },
  ];
  assert.deepEqual(pendingFunctionSlugs(bundle, new Set(["a", "b", "c"]), { a: "1", b: "2", c: "3" }), []);
  assert.deepEqual(pendingFunctionSlugs(bundle, new Set(["a", "c"]), { a: "1", b: "2", c: "3" }), ["b"]);
  // Desplegada fuera del wizard (sin hash) o en otra versión → se redespliega.
  assert.deepEqual(pendingFunctionSlugs(bundle, new Set(["a", "b", "c"]), { a: "1", c: "viejo" }), ["b", "c"]);
});

// ── Cierre del registro público ──────────────────────────────────────────────────
type Call = { url: string; method: string; body?: string; auth?: string };
function fakeFetch(responses: Array<{ status: number; json?: unknown }>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined, auth: h.Authorization });
    const r = responses.shift();
    if (!r) throw new Error("llamada inesperada");
    return new Response(r.json === undefined ? "" : JSON.stringify(r.json), { status: r.status });
  };
  return { calls, impl };
}

test("cierra con PATCH disable_signup:true sobre el ref del despliegue y VERIFICA con GET", async () => {
  const f = fakeFetch([{ status: 200, json: {} }, { status: 200, json: { disable_signup: true } }]);
  assert.deepEqual(await lockPublicSignup("abcxyz123", "sbp_x", f.impl), { ok: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].method, "PATCH");
  assert.equal(f.calls[0].url, "https://api.supabase.com/v1/projects/abcxyz123/config/auth");
  assert.deepEqual(JSON.parse(f.calls[0].body!), { disable_signup: true });
  assert.equal(f.calls[0].auth, "Bearer sbp_x");
  assert.equal(f.calls[1].method, "GET");
});

test("si el GET no confirma disable_signup === true, es un fallo (no se da por cerrado)", async () => {
  for (const cfg of [{ disable_signup: false }, {}, { disable_signup: "true" }]) {
    const f = fakeFetch([{ status: 200, json: {} }, { status: 200, json: cfg }]);
    const r = await lockPublicSignup("ref", "sbp_x", f.impl);
    assert.equal(r.ok, false, JSON.stringify(cfg));
  }
});

test("PATCH rechazado, GET fallido o red caída: error claro, sin lanzar", async () => {
  const a = await lockPublicSignup("ref", "sbp_x", fakeFetch([{ status: 401, json: { message: "unauthorized" } }]).impl);
  assert.equal(a.ok, false);
  if (!a.ok) assert.match(a.error, /401/);
  const b = await lockPublicSignup("ref", "sbp_x", fakeFetch([{ status: 200, json: {} }, { status: 500 }]).impl);
  assert.equal(b.ok, false);
  const c = await lockPublicSignup("ref", "sbp_x", async () => {
    throw new Error("ECONNRESET");
  });
  assert.equal(c.ok, false);
  if (!c.ok) assert.match(c.error, /ECONNRESET/);
});

// ── Guardias de código ───────────────────────────────────────────────────────────
const SRC = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

test("migrate y functions/deploy: pasan por authorizeProvision, ignoran el ref del body y eligen token con pickProvisionToken", () => {
  for (const rel of ["app/api/provision/migrate/route.ts", "app/api/provision/functions/deploy/route.ts"]) {
    const src = read(rel);
    assert.match(src, /await authorizeProvision\(/, rel);
    assert.match(src, /pickProvisionToken\(gate\.mode/, rel);
    assert.match(src, /const ref = provisionRef\(supabaseUrl\)/, rel);
    assert.doesNotMatch(src, /body\.ref|bodyRef|ref:\s*bodyRef/, `${rel} lee el ref del body`);
    // El guardado solo se lee con sesión.
    assert.match(src, /gate\.mode === "session" \? await readAccessToken/, rel);
    // La autorización va ANTES de leer el body (lectura única: readJson de lib/api/body).
    const bodyRead = src.indexOf("readJson(request");
    assert.ok(bodyRead > 0, `${rel}: no lee el body con readJson`);
    assert.ok(src.indexOf("authorizeProvision(") < bodyRead, `${rel}: autoriza después de leer el body`);
  }
});

test("transición: un usuario sin rol solo pasa mientras la migración de roles NO esté aplicada", () => {
  assert.equal(legacySinRolPermitido(true, false, true), true); // maestro sin rol, 0078 sin aplicar
  assert.equal(legacySinRolPermitido(true, true, true), false); // 0078 ya aplicada: la excepción se apagó
  assert.equal(legacySinRolPermitido(true, null, true), false); // no se pudo leer → cerrado
  assert.equal(legacySinRolPermitido(false, false, true), false); // con rol insuficiente (p. ej. operacion) nunca
  // R1: un sin-rol que NO es el maestro (p. ej. una cuenta de un registro público abierto) nunca
  assert.equal(legacySinRolPermitido(true, false, false), false);
});

test("la excepción de transición solo está en migrate (no en deploy ni register; SuperCines no tiene /updates)", () => {
  assert.match(read("app/api/provision/migrate/route.ts"), /legacySinRol: true/);
  assert.doesNotMatch(read("app/api/provision/functions/deploy/route.ts"), /legacySinRol: true/);
});

test("status no toca el token guardado", () => {
  const status = read("app/api/provision/status/route.ts");
  assert.doesNotMatch(status, /readAccessToken|config-token|runQuery|listFunctions/);
});

test("el maestro del first-run nace con rol configuracion explícito y register cierra el registro público", () => {
  const admin = read("lib/provision/admin.ts");
  assert.match(admin, /MASTER_ROLE = "configuracion"/);
  assert.match(admin, /app_metadata: \{ role: MASTER_ROLE \}/);
  const register = read("app/api/provision/register/route.ts");
  assert.match(register, /createMasterUser\(/);
  assert.match(register, /lockPublicSignup\(ref, accessToken\)/);
  assert.doesNotMatch(register, /readAccessToken/);
});

test("masterUserId: el creado primero (created_at, id); el empate lo desempata el id; fechas ilegibles se ignoran", () => {
  assert.equal(
    masterUserId([
      { id: "b", created_at: "2026-02-01T00:00:00Z" },
      { id: "a", created_at: "2026-01-01T00:00:00Z" },
      { id: "c", created_at: "2026-03-01T00:00:00Z" },
    ]),
    "a"
  );
  assert.equal(masterUserId([{ id: "z", created_at: "2026-01-01T00:00:00Z" }, { id: "m", created_at: "2026-01-01T00:00:00Z" }]), "m");
  assert.equal(masterUserId([{ id: "x", created_at: "no-es-fecha" }, { id: "y", created_at: "2026-01-01T00:00:00Z" }]), "y");
  assert.equal(masterUserId([]), null);
});

test("ensureSignupLocked: cierra y verifica, memoriza lo verificado y reintenta si falló", async () => {
  const { ensureSignupLocked, resetSignupLockMemo, SIGNUP_RECHECK_MS } = await import("./provision/ensure-signup-lock.ts");
  resetSignupLockMemo();
  let calls = 0;
  let ok = false;
  const lock = async () => {
    calls++;
    return ok ? ({ ok: true } as const) : ({ ok: false, error: "x" } as const);
  };
  let t = 1_000;
  const now = () => t;
  assert.deepEqual(await ensureSignupLocked("ref", "sbp", { now, lock }), { ok: false, error: "x" });
  assert.deepEqual(await ensureSignupLocked("ref", "sbp", { now, lock }), { ok: false, error: "x" }); // un fallo NO se memoriza
  assert.equal(calls, 2);
  ok = true;
  assert.deepEqual(await ensureSignupLocked("ref", "sbp", { now, lock }), { ok: true });
  assert.deepEqual(await ensureSignupLocked("ref", "sbp", { now, lock }), { ok: true }); // memorizado
  assert.equal(calls, 3);
  t += SIGNUP_RECHECK_MS + 1; // vence la memoria: se vuelve a verificar
  await ensureSignupLocked("ref", "sbp", { now, lock });
  assert.equal(calls, 4);
});

test("guardia: migrate cierra y verifica el registro público al correr; el gate exige al maestro", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  for (const r of ["../app/api/provision/migrate/route.ts"]) {
    assert.match(read(r), /ensureSignupLocked\(ref, token\)/, r);
  }
  assert.match(read("./provision/gate.ts"), /masterUserId\(await listAllUsersBrief/);
});

// ───────────────────────── Primer arranque: contar usuarios falla, instalación provisionada, secreto de arranque ─────────────────────────
import { RECOVERY_HINT } from "./provision/gate-logic.ts";
import { isMissingTableError, isUniqueViolation, PROVISIONED_KEY } from "./provision/provisioned.ts";
import { validateProjectToken } from "./provision/project-token.ts";

test("(a) si NO se pudo contar usuarios o leer el marcador: 503, nunca primer arranque abierto", () => {
  for (const [users, prov] of [[null, false], [null, true], [null, null], [0, null], [3, null]] as const) {
    const d = provisionNeedsSession(users, prov);
    assert.notEqual(d, "check-session", `${users}/${prov}`);
    if (d !== "check-session") {
      assert.equal(d.ok, false, `${users}/${prov}`);
      if (!d.ok) assert.equal(d.status, 503, `${users}/${prov}`);
    }
  }
});

test("(b) primer arranque = sin usuarios Y sin marcador; provisionada sin usuarios = recuperación (403), nunca abierta", () => {
  assert.deepEqual(provisionNeedsSession(0, false), { ok: true, mode: "first-boot" });
  const rec = provisionNeedsSession(0, true);
  assert.notEqual(rec, "check-session");
  if (rec !== "check-session") {
    assert.equal(rec.ok, false);
    if (!rec.ok) {
      assert.equal(rec.status, 403);
      assert.equal(rec.error, RECOVERY_HINT);
      assert.match(rec.error, /Authentication → Users/); // el procedimiento documentado
    }
  }
  // con usuarios manda la sesión, haya o no marcador
  assert.equal(provisionNeedsSession(2, true), "check-session");
  assert.equal(provisionNeedsSession(2, false), "check-session");
  // por omisión (llamadores viejos) no se reabre nada que no fuera primer arranque
  assert.equal(provisionNeedsSession(1), "check-session");
});

test("(b) el marcador: clave fija, y se distingue «falta la tabla» (migraciones sin aplicar) de un error real", () => {
  assert.equal(PROVISIONED_KEY, "PROVISIONED_AT");
  for (const c of ["42P01", "PGRST205", "PGRST106"]) assert.equal(isMissingTableError(c), true, c);
  for (const c of [undefined, "23505", "PGRST301", "08006"]) assert.equal(isMissingTableError(c), false, String(c));
  assert.equal(isUniqueViolation("23505"), true);
  assert.equal(isUniqueViolation("42P01"), false);
});

test("(b) el register reclama el marcador ANTES de crear al maestro y lo libera si la creación falla; el gate lo lee sin usuarios", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const reg = read("../app/api/provision/register/route.ts");
  const iTok = reg.indexOf("validateProjectToken(");
  const iClaim = reg.indexOf("claimProvisioned(");
  const iCreate = reg.indexOf("createMasterUser(supabaseUrl");
  assert.ok(iTok > 0 && iClaim > iTok && iCreate > iClaim, "orden: token → marcador → crear maestro");
  assert.match(reg, /releaseProvisioned\(/);
  assert.match(read("./provision/gate.ts"), /readProvisioned\(supabaseUrl, serviceRoleKey\)/);
  // 0083 backfillea el marcador para instalaciones con usuarios
  assert.match(read("../../../supabase/migrations/0083_provisioned_marker.sql"), /where exists \(select 1 from auth\.users\)/);
});

test("(c) el register exige un token sbp_ que pueda LEER este proyecto en la Management API", async () => {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const mk = (status: number) => async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return new Response("{}", { status });
  };
  assert.deepEqual(await validateProjectToken("abcxyz", "sbp_ok", mk(200)), { ok: true });
  // consulta ESTE ref, con el token en el header (nunca en la URL)
  assert.equal(calls[0].url, "https://api.supabase.com/v1/projects/abcxyz");
  assert.equal(calls[0].auth, "Bearer sbp_ok");
  assert.ok(!calls[0].url.includes("sbp_ok"));
  // token de otra cuenta / inventado / sin acceso a ese proyecto → 403, sin crear nada
  for (const st of [401, 403, 404]) {
    const r = await validateProjectToken("abcxyz", "sbp_ajeno", mk(st));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403, String(st));
  }
  // la Management API caída NO se confunde con «token inválido»: 502
  const down = await validateProjectToken("abcxyz", "sbp_x", mk(500));
  assert.equal(down.ok, false);
  if (!down.ok) assert.equal(down.status, 502);
  const boom = await validateProjectToken("abcxyz", "sbp_x", async () => { throw new Error("red"); });
  assert.equal(boom.ok, false);
  if (!boom.ok) assert.equal(boom.status, 502);
  // sin token: 401, sin llamar a nadie
  const before = calls.length;
  const vacio = await validateProjectToken("abcxyz", "   ", mk(200));
  assert.equal(vacio.ok, false);
  assert.equal(calls.length, before);
});

test("escalada: un registrado por el registro público (sin rol, no maestro) NO se promueve con la transición ni con el backfill", () => {
  const users = [
    { id: "maestro", created_at: "2026-01-01T00:00:00Z" },
    { id: "atacante", created_at: "2026-06-01T00:00:00Z" }, // se registró después, con el registro público abierto
  ];
  const master = masterUserId(users);
  assert.equal(master, "maestro");
  for (const [id, esperado] of [["maestro", true], ["atacante", false]] as const) {
    // 0078 todavía sin aplicar, usuario sin rol
    assert.equal(legacySinRolPermitido(true, false, master === id), esperado, id);
  }
});
