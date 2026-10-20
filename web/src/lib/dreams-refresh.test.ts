import test from "node:test";
import assert from "node:assert/strict";
import { planApprove, refreshesOf, toArchivePath } from "./dreams-refresh.ts";

// Revisión de c833dd4: un refresco de un dream ACTIVO que la política no activaría queda
// pendiente con `refreshes: <id>`; recién al aprobarlo se reemplaza el activo, que se ARCHIVA
// (nunca se borra). Paridad con supabase/functions/_shared/dreams-refresh.ts.

const fm = (extra = "") => `---\ncategory: anti_pattern\n${extra}---\n\n# t\n\nRegla nueva.\n`;
const pending = { id: "p1", path: "/dreams-pending/daily/2026-10-20_00_sug_x_v3.md", content: fm('refreshes: "a1"\n') };
const active = { id: "a1", path: "/dreams/daily/2026-10-10_00_sug_x.md", content: "viejo" };

test("refreshesOf lee el id del frontmatter (con o sin comillas) y rechaza lo que no es un id", () => {
  assert.equal(refreshesOf(fm('refreshes: "a1"\n')), "a1");
  assert.equal(refreshesOf(fm("refreshes: a1\n")), "a1");
  assert.equal(refreshesOf(fm()), null);
  assert.equal(refreshesOf(fm('refreshes: "../../x"\n')), null);
});

test("aprobar un pendiente sin refreshes: crea el activo y borra el pendiente", () => {
  const p = { ...pending, content: fm() };
  assert.deepEqual(planApprove(p, null), [
    { op: "create", path: "/dreams/daily/2026-10-20_00_sug_x_v3.md", content: p.content },
    { op: "delete", id: "p1" },
  ]);
});

test("aprobar un refresco: archiva el activo ANTES de tocarlo, crea el nuevo, borra el original y el pendiente", () => {
  assert.deepEqual(planApprove(pending, active), [
    { op: "archive", path: toArchivePath(active.path), content: "viejo" },
    { op: "create", path: "/dreams/daily/2026-10-20_00_sug_x_v3.md", content: pending.content },
    { op: "delete", id: "a1" },
    { op: "delete", id: "p1" },
  ]);
});

test("si el activo ya no existe o no es activo, se aprueba como uno nuevo (nunca se borra otra cosa)", () => {
  assert.deepEqual(planApprove(pending, null)?.map((s) => s.op), ["create", "delete"]);
  const archived = { ...active, path: "/dreams-archive/daily/x.md" };
  assert.deepEqual(planApprove(pending, archived)?.map((s) => s.op), ["create", "delete"]);
});

test("mismo path que el original: se borra el original (ya archivado) antes de crear", () => {
  const same = { ...pending, path: "/dreams-pending/daily/2026-10-10_00_sug_x.md" };
  assert.deepEqual(planApprove(same, active)?.map((s) => s.op), ["archive", "delete", "create", "delete"]);
});

test("solo se aprueba algo pendiente", () => {
  assert.equal(planApprove({ ...pending, path: "/dreams/daily/x.md" }, null), null);
});

test("refreshesOf rechaza un frontmatter con `refreshes` repetido (misma regla que la Edge)", () => {
  assert.equal(refreshesOf('---\nrefreshes: "mem_abc"\n---\n\n# t\n'), "mem_abc");
  assert.equal(refreshesOf('---\nrefreshes: "mem_abc"\nrefreshes: "mem_victima"\n---\n\n# t\n'), null);
});
