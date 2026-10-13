// La lista TS de estados de draft (draft-status.ts) refleja EXACTAMENTE el CHECK de la
// base (la última migración que define drafts_status_check o, si ninguna lo redefine,
// el check inline de 0001). Un estado nuevo en la base sin reflejo en el panel (como
// `publishing`, 0074) se trataría como «pendiente» y ofrecería aprobarlo de nuevo.
// Correr con: cd web && node --test src/lib/draft-status.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DRAFT_APPROVABLE_STATUSES,
  DRAFT_REJECTABLE_STATUSES,
  DRAFT_STATUSES,
} from "./draft-status.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "supabase", "migrations");

function statusesFromDb(): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let last: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    // 0001: `status text not null default 'pending' check (status in (...))` en create table drafts.
    const inline = /create table if not exists drafts \([\s\S]*?status text[^,]*?check \(status in \(([^)]*)\)\)/i.exec(sql);
    if (inline) last = inline[1];
    for (const m of sql.matchAll(/add constraint drafts_status_check\s+check \(status in \(([^)]*)\)\)/gi)) last = m[1];
  }
  assert.ok(last, "no se encontró la definición de drafts_status_check en las migraciones");
  return [...last.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

test("DRAFT_STATUSES = los estados del CHECK de la base", () => {
  assert.deepEqual([...DRAFT_STATUSES].sort(), statusesFromDb());
});

test("el panel nunca aprueba ni rechaza un draft que se está enviando o ya se resolvió", () => {
  for (const s of ["publishing", "sent", "auto_sent", "rejected", "failed"] as const) {
    assert.ok(!DRAFT_APPROVABLE_STATUSES.includes(s), `aprobar desde ${s}`);
    assert.ok(!DRAFT_REJECTABLE_STATUSES.includes(s), `rechazar desde ${s}`);
  }
});
