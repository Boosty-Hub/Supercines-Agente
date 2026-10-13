// _shared/models.test.ts
// Correr con: deno test supabase/functions/_shared/models.test.ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { effortFor, modelFor } from "./models.ts";

Deno.test("modelFor: DB-first, default Haiku 5.5 si falta", () => {
  const cfg = (v?: string) => ({ getOr: (_k: string, d: string) => v ?? d });
  assertEquals(modelFor(cfg(), "CLASSIFY_MODEL"), "claude-haiku-5-5");
  assertEquals(modelFor(cfg("claude-sonnet-4-6"), "AGENT_MODEL"), "claude-sonnet-4-6");
});

Deno.test("effortFor: Haiku 4.5 rechaza output_config.effort (400) => no se envía; los demás sí", () => {
  assertEquals(effortFor("claude-haiku-4-5", "low"), {});
  assertEquals(effortFor("claude-haiku-5-5", "low"), { effort: "low" });
  assertEquals(effortFor("claude-sonnet-4-6", "medium"), { effort: "medium" });
  assertEquals(effortFor("claude-opus-4-8", "high"), { effort: "high" });
});
