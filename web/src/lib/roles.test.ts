// Alcances: «sin rol = sin acceso» (fail-closed) y lo que puede ver cada alcance.
// Correr con: cd web && node --test src/lib/roles.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esBajaDeAlcance,
  getScope,
  inicioPara,
  RUTA_SIN_ACCESO,
  rutaPermitida,
  SCOPES,
  scopeAlcanza,
  SIN_ACCESO,
} from "./auth/roles.ts";
import { jwtRoleDesfasado } from "./auth/jwt-role.ts";

const u = (role?: unknown) => ({ app_metadata: role === undefined ? {} : { role } });

test("sin rol (ausente, null, vacío, sin app_metadata, sin usuario) = SIN_ACCESO", () => {
  for (const user of [u(), u(null), u(""), { app_metadata: null }, {}, null, undefined]) {
    assert.equal(getScope(user), SIN_ACCESO, JSON.stringify(user));
  }
});

test("alcances explícitos, alias heredados e irreconocible", () => {
  assert.equal(getScope(u("configuracion")), "configuracion");
  assert.equal(getScope(u("contenido")), "contenido");
  assert.equal(getScope(u("operacion")), "operacion");
  assert.equal(getScope(u("admin")), "configuracion");
  assert.equal(getScope(u("editor")), "contenido");
  // Presente pero irreconocible: cae CERRADO (sin acceso), igual que las policies de 0078/0079.
  for (const r of ["Admin", "root", "superuser", 1, true, {}]) assert.equal(getScope(u(r)), SIN_ACCESO, String(r));
});

test("SIN_ACCESO no alcanza ningún alcance", () => {
  for (const s of SCOPES) assert.equal(scopeAlcanza(SIN_ACCESO, s), false, s);
});

test("SIN_ACCESO: solo /sin-acceso y /auth/*; nada del panel ni de la API (ni lo que no tiene alcance)", () => {
  for (const p of [RUTA_SIN_ACCESO, "/auth/signout", "/auth/callback"]) assert.equal(rutaPermitida(SIN_ACCESO, p), true, p);
  // Transición (la ruta decide: solo sin la migración de roles aplicada; ver provision-gate.test.ts).
  assert.equal(rutaPermitida(SIN_ACCESO, "/api/provision/migrate"), true);
  assert.equal(rutaPermitida(SIN_ACCESO, "/api/provision/updates"), false); // SuperCines no tiene esa ruta
  for (const p of [
    "/inbox", "/leads", "/alerts", "/usuarios", "/settings", "/agent",
    "/api/inbox/leads", "/api/users", "/api/provision/status", "/api/provision/functions/deploy",
    "/api/provision/register",
    "/first-run", "/", "/update-password", "/ruta-sin-alcance-declarado", "/api/algo-nuevo",
  ]) {
    assert.equal(rutaPermitida(SIN_ACCESO, p), false, p);
  }
  assert.equal(inicioPara(SIN_ACCESO), RUTA_SIN_ACCESO);
});

test("los alcances reales siguen igual: operacion ve inbox y no configuracion; configuracion todo", () => {
  assert.equal(rutaPermitida("operacion", "/inbox"), true);
  assert.equal(rutaPermitida("operacion", "/usuarios"), false);
  assert.equal(rutaPermitida("operacion", "/api/provision/migrate"), false);
  assert.equal(rutaPermitida("configuracion", "/api/provision/migrate"), true);
  assert.equal(rutaPermitida("configuracion", "/usuarios"), true);
  for (const s of SCOPES) assert.equal(inicioPara(s), "/inbox");
});

test("esBajaDeAlcance: solo cuando el alcance nuevo es menor", () => {
  assert.equal(esBajaDeAlcance("configuracion", "contenido"), true);
  assert.equal(esBajaDeAlcance("configuracion", "operacion"), true);
  assert.equal(esBajaDeAlcance("contenido", "operacion"), true);
  assert.equal(esBajaDeAlcance("operacion", "contenido"), false);
  assert.equal(esBajaDeAlcance("contenido", "contenido"), false);
  assert.equal(esBajaDeAlcance(SIN_ACCESO, "operacion"), false);
  assert.equal(esBajaDeAlcance(SIN_ACCESO, "configuracion"), false);
});

test("jwtRoleDesfasado: refrescar solo si el rol del token difiere del real", () => {
  const tok = (payload: unknown) =>
    ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "firma"].join(".");
  assert.equal(jwtRoleDesfasado(tok({ app_metadata: {} }), "configuracion"), true); // backfill de 0078
  assert.equal(jwtRoleDesfasado(tok({ app_metadata: { role: "operacion" } }), "contenido"), true);
  assert.equal(jwtRoleDesfasado(tok({ app_metadata: { role: "contenido" } }), "contenido"), false);
  assert.equal(jwtRoleDesfasado(tok({ app_metadata: { role: "" } }), undefined), false);
  assert.equal(jwtRoleDesfasado(tok({}), null), false);
  assert.equal(jwtRoleDesfasado(tok({ app_metadata: { role: "ñandú" } }), "ñandú"), false); // UTF-8
  for (const t of [null, undefined, "", "basura", "a.%%%.c"]) assert.equal(jwtRoleDesfasado(t, "configuracion"), false);
});

test("esSinRol: ausente, null y '' son sin rol; un rol irreconocible NO (no entra por la transición del provisioner)", async () => {
  const { esSinRol } = await import("./auth/roles.ts");
  for (const r of [undefined, null, ""]) assert.equal(esSinRol({ app_metadata: { role: r } }), true, String(r));
  assert.equal(esSinRol({ app_metadata: {} }), true);
  assert.equal(esSinRol(null), true);
  for (const r of ["root", "Admin ", 1, true]) assert.equal(esSinRol({ app_metadata: { role: r } }), false, String(r));
});

test("authorizeScope: solo el usuario SIN rol lleva sinRol (transición); un rol irreconocible solo sinAcceso", async () => {
  const { authorizeScope } = await import("./auth/scope-guard.ts");
  const sinRol = authorizeScope({ app_metadata: {} }, "configuracion");
  assert.equal(sinRol.ok, false);
  if (!sinRol.ok) assert.deepEqual([sinRol.sinAcceso, sinRol.sinRol], [true, true]);
  const raro = authorizeScope({ app_metadata: { role: "root" } }, "configuracion");
  assert.equal(raro.ok, false);
  if (!raro.ok) assert.deepEqual([raro.sinAcceso, raro.sinRol], [true, undefined]);
});
