// supabase/tests/dashboard-ai-body.test.ts
// Captura el body HTTP REAL que el AI SDK (las mismas versiones que usa web/)
// arma para /v1/messages y afirma lo que Haiku 5.5 exige: sin temperature /
// top_p / top_k, con output_config.effort. Regresión de un bug real: ai@4 manda
// `temperature: 0` por default y Haiku 5.5 lo rechaza con 400 (rompía las 8 rutas
// de IA del dashboard).
// Correr con: deno test --allow-read --allow-net --allow-env --node-modules-dir=none supabase/tests/dashboard-ai-body.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { generateObject, generateText } from "npm:ai@4.3.19";
import { createAnthropic } from "npm:@ai-sdk/anthropic@1.2.12";
import { z } from "npm:zod@3";
import { shapedFetch } from "../../web/src/lib/model-capabilities.ts";

type Captured = Record<string, unknown>;

function interceptor(captured: Captured[], reply: unknown): typeof fetch {
  return (_input, init) => {
    captured.push(JSON.parse(init!.body as string));
    return Promise.resolve(
      new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

const usage = { input_tokens: 5, output_tokens: 5 };
const textReply = (model: string) => ({
  id: "msg_1", type: "message", role: "assistant", model, stop_reason: "end_turn", stop_sequence: null,
  content: [{ type: "text", text: "hola" }], usage,
});
const toolReply = (model: string) => ({
  id: "msg_2", type: "message", role: "assistant", model, stop_reason: "tool_use", stop_sequence: null,
  content: [{ type: "tool_use", id: "tu_1", name: "json", input: { ok: true } }], usage,
});

for (const model of ["claude-haiku-5-5", "claude-opus-4-8"]) {
  Deno.test(`${model}: generateObject y generateText NO mandan temperature/top_p/top_k; sí effort`, async () => {
    const captured: Captured[] = [];
    const anthropic = createAnthropic({ apiKey: "k", fetch: shapedFetch("low", interceptor(captured, toolReply(model))) });
    await generateObject({ model: anthropic(model), schema: z.object({ ok: z.boolean() }), prompt: "x" });
    const anthropic2 = createAnthropic({ apiKey: "k", fetch: shapedFetch("medium", interceptor(captured, textReply(model))) });
    await generateText({ model: anthropic2(model), prompt: "x" });

    assertEquals(captured.length, 2);
    for (const body of captured) {
      for (const k of ["temperature", "top_p", "top_k"]) assert(!(k in body), `${k} presente en ${JSON.stringify(body)}`);
      assertEquals(body.model, model);
    }
    assertEquals((captured[0].output_config as { effort: string }).effort, "low");
    assertEquals((captured[1].output_config as { effort: string }).effort, "medium");
  });
}

Deno.test("SIN el wrapper el AI SDK sí manda temperature:0 (documenta por qué existe)", async () => {
  const captured: Captured[] = [];
  const anthropic = createAnthropic({ apiKey: "k", fetch: interceptor(captured, textReply("claude-haiku-5-5")) });
  await generateText({ model: anthropic("claude-haiku-5-5"), prompt: "x" });
  assertEquals(captured[0].temperature, 0);
});

Deno.test("claude-haiku-4-5: conserva sampling (lo acepta) y NO lleva effort (lo rechaza)", async () => {
  const captured: Captured[] = [];
  const anthropic = createAnthropic({ apiKey: "k", fetch: shapedFetch("low", interceptor(captured, textReply("claude-haiku-4-5"))) });
  await generateText({ model: anthropic("claude-haiku-4-5"), prompt: "x" });
  assertEquals(captured[0].temperature, 0);
  assert(!("output_config" in captured[0]));
});
