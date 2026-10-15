// /api/users*: alcance explícito siempre, revocación de sesiones al bajar alcance o borrar, y
// toda ruta del módulo detrás de requireScope("configuracion").
// Correr con: cd web && node --test src/lib/users-mutations.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyUserDelete, applyUserUpdate, validateCreate, validatePatch, type UserRow } from "./users/mutations.ts";
import { SIN_ACCESO, type Alcance, type Scope } from "./auth/roles.ts";

function fake(users: UserRow[], opts: { revokeFails?: string } = {}) {
  const calls: string[] = [];
  const db = new Map(users.map((x) => [x.id, { ...x }]));
  return {
    calls,
    db,
    deps: {
      async listUsers() {
        return [...db.values()];
      },
      async updateUser(id: string, patch: { scope?: Scope; password?: string }) {
        calls.push(`update:${id}:${patch.scope ?? "-"}`);
        const row = db.get(id)!;
        if (patch.scope) row.scope = patch.scope;
        return row;
      },
      async deleteUser(id: string) {
        calls.push(`delete:${id}`);
        db.delete(id);
      },
      async revokeSessions(id: string) {
        calls.push(`revoke:${id}`);
        if (opts.revokeFails) throw new Error(opts.revokeFails);
      },
    },
  };
}

const row = (id: string, scope: Alcance): UserRow => ({ id, scope });

test("crear: el alcance es obligatorio y explícito (sin alcance = 400, nunca un alta sin rol)", () => {
  for (const scope of [undefined, null, "", "root", "Admin"]) {
    const v = validateCreate({ email: "a@b.co", password: "12345678", scope });
    assert.equal(v.ok, false, String(scope));
  }
  const ok = validateCreate({ email: " A@B.co ", password: "12345678", scope: "operacion" });
  assert.deepEqual(ok, { ok: true, email: "a@b.co", password: "12345678", scope: "operacion" });
  const alias = validateCreate({ email: "a@b.co", password: "12345678", role: "admin" });
  assert.equal(alias.ok && alias.scope, "configuracion");
});

test("patch: alcance inválido o vacío se rechaza", () => {
  assert.equal(validatePatch({ scope: "x" }).ok, false);
  assert.equal(validatePatch({}).ok, false);
  assert.equal(validatePatch({ password: "corta" }).ok, false);
  const v = validatePatch({ scope: "contenido" });
  assert.deepEqual(v, { ok: true, patch: { scope: "contenido" } });
});

test("bajar alcance: actualiza y DESPUÉS revoca las sesiones", async () => {
  const f = fake([row("admin", "configuracion"), row("otro", "configuracion")]);
  const r = await applyUserUpdate(f.deps, { actorId: "admin", targetId: "otro", patch: { scope: "operacion" } });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.revoked, true);
  assert.deepEqual(f.calls, ["update:otro:operacion", "revoke:otro"]);
});

test("subir alcance o asignar a un sin-rol: no revoca", async () => {
  const f = fake([row("admin", "configuracion"), row("op", "operacion"), row("nuevo", SIN_ACCESO)]);
  await applyUserUpdate(f.deps, { actorId: "admin", targetId: "op", patch: { scope: "contenido" } });
  await applyUserUpdate(f.deps, { actorId: "admin", targetId: "nuevo", patch: { scope: "operacion" } });
  assert.equal(f.calls.filter((c) => c.startsWith("revoke")).length, 0);
});

test("cambiar la contraseña REVOCA las sesiones del usuario (la Admin API no invalida los refresh tokens)", async () => {
  const f = fake([row("admin", "configuracion"), row("op", "operacion")]);
  const r = await applyUserUpdate(f.deps, { actorId: "admin", targetId: "op", patch: { password: "12345678" } });
  assert.equal(r.ok && r.revoked, true);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("revoke")), ["revoke:op"]);
  // si el RPC falla, la respuesta lo dice y aclara que la contraseña SÍ cambió
  const g = fake([row("admin", "configuracion"), row("op", "operacion")], { revokeFails: "no existe" });
  const e = await applyUserUpdate(g.deps, { actorId: "admin", targetId: "op", patch: { password: "12345678" } });
  assert.equal(e.ok, false);
  if (!e.ok) assert.match(e.error, /La contraseña se cambió/);
});

test("si el RPC de revocar no existe: error claro que dice que el alcance SÍ cambió", async () => {
  const f = fake([row("admin", "configuracion"), row("otro", "contenido")], {
    revokeFails: "la función revoke_user_sessions no existe en la base",
  });
  const r = await applyUserUpdate(f.deps, { actorId: "admin", targetId: "otro", patch: { scope: "operacion" } });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 500);
    assert.match(r.error, /alcance se cambió/);
    assert.match(r.error, /revoke_user_sessions/);
    assert.match(r.error, /jwt_expiry/);
  }
  assert.equal(f.db.get("otro")!.scope, "operacion");
});

test("no bajarse a sí mismo ni dejar el panel sin administradores", async () => {
  const f = fake([row("admin", "configuracion"), row("op", "operacion")]);
  const self = await applyUserUpdate(f.deps, { actorId: "admin", targetId: "admin", patch: { scope: "operacion" } });
  assert.equal(self.ok, false);
  const f2 = fake([row("a", "configuracion"), row("b", "contenido")]);
  const last = await applyUserUpdate(f2.deps, { actorId: "b", targetId: "a", patch: { scope: "operacion" } });
  assert.equal(last.ok, false);
  assert.deepEqual([...f.calls, ...f2.calls], []);
});

test("borrar: revoca ANTES de borrar; si revocar falla, borra igual e informa", async () => {
  const f = fake([row("admin", "configuracion"), row("op", "operacion")]);
  assert.deepEqual(await applyUserDelete(f.deps, { actorId: "admin", targetId: "op" }), { ok: true });
  assert.deepEqual(f.calls, ["revoke:op", "delete:op"]);

  const g = fake([row("admin", "configuracion"), row("op", "operacion")], { revokeFails: "PGRST202" });
  const r = await applyUserDelete(g.deps, { actorId: "admin", targetId: "op" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /se borró/);
  assert.deepEqual(g.calls, ["revoke:op", "delete:op"]);
});

test("borrar: ni a sí mismo, ni al último administrador, ni a un inexistente", async () => {
  const f = fake([row("admin", "configuracion")]);
  assert.equal((await applyUserDelete(f.deps, { actorId: "admin", targetId: "admin" })).ok, false);
  const g = fake([row("a", "configuracion"), row("b", "contenido")]);
  assert.equal((await applyUserDelete(g.deps, { actorId: "b", targetId: "a" })).ok, false);
  const h = fake([row("a", "configuracion")]);
  const r = await applyUserDelete(h.deps, { actorId: "a", targetId: "zzz" });
  assert.equal(!r.ok && r.status, 404);
  assert.deepEqual([...f.calls, ...g.calls, ...h.calls], []);
});

// ── Guardia de código ───────────────────────────────────────────────────────────
const SRC = fileURLToPath(new URL("..", import.meta.url));
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('toda ruta de /api/users* llama requireScope("configuracion") en CADA handler', () => {
  const rutas = walk(join(SRC, "app/api/users")).filter((p) => /route\.ts$/.test(p));
  assert.ok(rutas.length >= 2, "no se encontraron las rutas de /api/users");
  for (const p of rutas) {
    const src = readFileSync(p, "utf8");
    const handlers = [...src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)];
    assert.ok(handlers.length > 0, p);
    const cuerpos = src.split(/export async function /).slice(1);
    for (const c of cuerpos) {
      assert.match(c, /requireScope\("configuracion"\)/, `${p}: ${c.slice(0, 12)} sin requireScope("configuracion")`);
    }
  }
});

test("lib/users/admin usa el cliente de servicio (no un fetch propio a la Admin API)", () => {
  const src = readFileSync(join(SRC, "lib/users/admin.ts"), "utf8");
  assert.match(src, /from "@\/lib\/supabase\/service"/);
  assert.doesNotMatch(src, /auth\/v1\/admin|SUPABASE_SERVICE_ROLE_KEY/);
});
