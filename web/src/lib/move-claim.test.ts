// Tests del TTL de la reserva de movimiento. Correr con: cd web && node --test src/lib/move-claim.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { kommoMoveWorstCaseMs, MOVE_CLAIM_TTL_SECONDS } from "./move-claim.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

test("el peor caso de Kommo es 2 PATCH de 8 s + 1,2 s de espera tras el 429", () => {
  assert.equal(kommoMoveWorstCaseMs(), 17_200);
});

test("el TTL de la reserva supera el peor caso con holgura (≥ 30 s y ≥ 2× el peor caso)", () => {
  assert.ok(MOVE_CLAIM_TTL_SECONDS >= 30);
  assert.ok(MOVE_CLAIM_TTL_SECONDS * 1000 >= 2 * kommoMoveWorstCaseMs());
});

test("moveLeadInKommo usa las constantes compartidas (no números sueltos)", () => {
  const src = readFileSync(here("./kommo.ts"), "utf8");
  const body = src.slice(src.indexOf("export async function moveLeadInKommo"));
  assert.match(body, /AbortSignal\.timeout\(KOMMO_MOVE_TIMEOUT_MS\)/);
  assert.match(body, /KOMMO_MOVE_429_BACKOFF_MS/);
  assert.match(body, /KOMMO_MOVE_ATTEMPTS/);
});

test("el default de claim_lead_move en la base coincide con MOVE_CLAIM_TTL_SECONDS", () => {
  const sql = readFileSync(here("../../../supabase/migrations/0065_kommo_pipelines_board.sql"), "utf8");
  const m = sql.match(/create function claim_lead_move\([\s\S]*?p_ttl_seconds\s+int\s+default\s+(\d+)/);
  assert.ok(m, "no se encontró claim_lead_move en 0065");
  assert.equal(Number(m[1]), MOVE_CLAIM_TTL_SECONDS);
});

test("la ruta de etapa pasa el TTL y suelta la reserva CON su token", () => {
  const src = readFileSync(here("../app/api/leads/[id]/stage/route.ts"), "utf8");
  assert.match(src, /p_ttl_seconds:\s*MOVE_CLAIM_TTL_SECONDS/);
  assert.match(src, /release_lead_move",\s*\{\s*p_lead_id:\s*lead\.id,\s*p_token:\s*claim\.token\s*\}/);
});
