// Correr con: cd web && node --test src/lib/draft-review.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearNoReplyReview, markedReviewIds } from "./draft-review.ts";

const ID = "11111111-1111-4111-8111-111111111111";

test("solo desmarca los ids que marcó la compuerta, validados, de un draft no_reply", () => {
  assert.deepEqual(markedReviewIds({ no_reply: true, no_reply_marked_ids: [ID, "x", 3, "'; drop"] }), [ID]);
  assert.deepEqual(markedReviewIds({ no_reply: false, no_reply_marked_ids: [ID] }), []);
  assert.deepEqual(markedReviewIds({ no_reply: true }), []);
  assert.deepEqual(markedReviewIds(null), []);
});

test("clearNoReplyReview filtra por esos ids Y por el lote del draft (nunca otros del lead)", async () => {
  const calls: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["update", "in", "eq"]) {
    chain[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return chain;
    };
  }
  (chain as { then: unknown }).then = (r: (v: unknown) => void) => r({ error: null });
  const supabase = { from: (t: string) => (calls.push(["from", t]), chain) };
  // deno-lint-ignore no-explicit-any
  await clearNoReplyReview(supabase as any, "draft-1", { no_reply: true, no_reply_marked_ids: [ID] });
  assert.deepEqual(calls, [
    ["from", "messages"],
    ["update", [{ requires_human_review: false }]],
    ["in", ["id", [ID]]],
    ["eq", ["answered_by_draft_id", "draft-1"]],
    ["eq", ["requires_human_review", true]],
  ]);
  calls.length = 0;
  // deno-lint-ignore no-explicit-any
  await clearNoReplyReview(supabase as any, "draft-1", { no_reply: true });
  assert.deepEqual(calls, [], "sin ids marcados no toca nada");
});

test("approve y reject exigen alcance operacion con requireScope", () => {
  for (const r of ["approve", "reject"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "app", "api", "drafts", "[id]", r, "route.ts"), "utf8");
    assert.ok(src.includes('requireScope("operacion")'), r);
    assert.ok(src.includes("clearNoReplyReview(supabase, params.id, updated[0].agent_metadata)"), r);
  }
});
