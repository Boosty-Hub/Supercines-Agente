// _shared/llm.test.ts
// Correr con: deno test supabase/functions/_shared/llm.test.ts
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import {
  jsonOf,
  LlmEmptyError,
  LlmRefusalError,
  LlmTruncatedError,
  LLM_PROFILES,
  textOf,
} from "./llm.ts";

const usage = { input_tokens: 10, output_tokens: 5 };
const msg = (over: Record<string, unknown>) => ({
  content: [{ type: "text", text: "hola" }],
  stop_reason: "end_turn",
  stop_details: null,
  usage,
  ...over,
});

Deno.test("textOf: lee el bloque de texto aunque lo precedan bloques thinking (adaptive thinking)", () => {
  const r = msg({
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "  respuesta  " },
    ],
  });
  assertEquals(textOf(r, "t"), "  respuesta  ");
});

Deno.test("textOf: refusal => LlmRefusalError con categoría y usage", () => {
  const r = msg({
    content: [],
    stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber", explanation: "x" },
  });
  const e = assertThrows(() => textOf(r, "classify"), LlmRefusalError);
  assertEquals(e.category, "cyber");
  assertEquals(e.usage, usage);
  assert(e.message.includes("classify"));
});

Deno.test("textOf: refusal sin stop_details => categoría null (no explota)", () => {
  const r = msg({ content: [], stop_reason: "refusal", stop_details: undefined });
  assertEquals(assertThrows(() => textOf(r, "x"), LlmRefusalError).category, null);
});

Deno.test("textOf: max_tokens => LlmTruncatedError, NUNCA devuelve texto parcial", () => {
  const r = msg({
    content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "{\"a\":" }],
    stop_reason: "max_tokens",
  });
  assertThrows(() => textOf(r, "dreams"), LlmTruncatedError);
});

Deno.test("textOf: sin bloque de texto (solo thinking) => LlmEmptyError", () => {
  const r = msg({ content: [{ type: "thinking", thinking: "", signature: "s" }] });
  assertThrows(() => textOf(r, "x"), LlmEmptyError);
});

Deno.test("textOf: texto vacío => LlmEmptyError", () => {
  assertThrows(() => textOf(msg({ content: [{ type: "text", text: "   " }] }), "x"), LlmEmptyError);
});

Deno.test("jsonOf: parsea el JSON; JSON inválido tira con el label", () => {
  assertEquals(jsonOf<{ a: number }>(msg({ content: [{ type: "text", text: "{\"a\":1}" }] }), "g"), { a: 1 });
  const e = assertThrows(() => jsonOf(msg({ content: [{ type: "text", text: "no json" }] }), "grader"), Error);
  assert(e.message.includes("grader"));
});

Deno.test("LLM_PROFILES: effort explícito y max_tokens con holgura para el thinking en toda ruta", () => {
  assertEquals(LLM_PROFILES.classify.effort, "low");
  // Un JSON de salida corto compite con el thinking por max_tokens: nunca el tope "pelado" de Haiku 4.5.
  for (const [name, p] of Object.entries(LLM_PROFILES)) {
    assert(p.maxTokens >= 2048, name);
    assert(["low", "medium", "high"].includes(p.effort), name);
  }
});
