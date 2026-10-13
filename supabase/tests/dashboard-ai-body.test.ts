// supabase/tests/dashboard-ai-body.test.ts
// Captura el body HTTP REAL que el AI SDK (las MISMAS versiones que usa web/:
// ai@5.0.267 / @ai-sdk/anthropic@2.0.106; si web/package.json las cambia, este
// test debe actualizarse con ellas) arma para /v1/messages y afirma lo que
// Haiku 5.5 exige: sin temperature / top_p / top_k, con output_config.effort.
// Regresión de un bug real del template: ai@4 mandaba `temperature: 0` por
// default y Haiku 5.5 lo rechazaba con 400 (rompía las rutas de IA del dashboard).
// Correr con: deno test --no-check --node-modules-dir=none --allow-read --allow-net --allow-env supabase/tests/dashboard-ai-body.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { generateObject, generateText } from "npm:ai@5.0.267";
import { createAnthropic } from "npm:@ai-sdk/anthropic@2.0.106";
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

Deno.test("SIN el wrapper (ai@5): no manda temperature por default, pero tampoco effort => el thinking de Haiku 5.5 queda en el default", async () => {
  const captured: Captured[] = [];
  const anthropic = createAnthropic({ apiKey: "k", fetch: interceptor(captured, textReply("claude-haiku-5-5")) });
  await generateText({ model: anthropic("claude-haiku-5-5"), prompt: "x" });
  // En ai@4 esto era temperature:0 (400 en Haiku 5.5). ai@5 quitó ese default:
  // el wrapper sigue siendo necesario para inyectar el effort.
  assert(!("temperature" in captured[0]));
  assert(!("output_config" in captured[0]));
});

Deno.test("un temperature EXPLÍCITO se quita para Haiku 5.5 / Opus 4.8 (400 si llega) y se conserva en los modelos que lo aceptan", async () => {
  for (const [model, keeps] of [["claude-haiku-5-5", false], ["claude-opus-4-8", false], ["claude-haiku-4-5", true], ["claude-sonnet-4-6", true]] as const) {
    const captured: Captured[] = [];
    const anthropic = createAnthropic({ apiKey: "k", fetch: shapedFetch("low", interceptor(captured, textReply(model))) });
    await generateText({ model: anthropic(model), prompt: "x", temperature: 0.2, topP: 0.9 });
    assertEquals("temperature" in captured[0], keeps, `${model} temperature`);
    assertEquals("top_p" in captured[0], keeps, `${model} top_p`);
  }
});

Deno.test("claude-haiku-4-5: NO lleva effort (lo rechaza con 400)", async () => {
  const captured: Captured[] = [];
  const anthropic = createAnthropic({ apiKey: "k", fetch: shapedFetch("low", interceptor(captured, textReply("claude-haiku-4-5"))) });
  await generateText({ model: anthropic("claude-haiku-4-5"), prompt: "x" });
  assert(!("output_config" in captured[0]));
});

// @ai-sdk/anthropic@2 no conoce claude-haiku-5-5: sin maxOutputTokens manda
// max_tokens=128000 en generateObject. El tope tiene que VIAJAR en el body real.
Deno.test("maxOutputTokens explícito llega como max_tokens al body (sin él, el SDK manda un tope enorme)", async () => {
  const captured: Captured[] = [];
  const anthropic = createAnthropic({ apiKey: "k", fetch: shapedFetch("low", interceptor(captured, toolReply("claude-haiku-5-5"))) });
  await generateObject({ model: anthropic("claude-haiku-5-5"), schema: z.object({ ok: z.boolean() }), prompt: "x", maxOutputTokens: 8000 });
  await generateObject({ model: anthropic("claude-haiku-5-5"), schema: z.object({ ok: z.boolean() }), prompt: "x" });
  assertEquals(captured[0].max_tokens, 8000);
  assert(Number(captured[1].max_tokens) > 16000, `sin tope el SDK manda ${captured[1].max_tokens}: por eso cada llamada lo fija`);
});

Deno.test("PARIDAD: toda generateObject / streamText de las rutas del dashboard fija maxOutputTokens", async () => {
  const root = new URL("../../web/src/app/api/", import.meta.url);
  const files: string[] = [];
  async function walk(dir: URL) {
    for await (const e of Deno.readDir(dir)) {
      const child = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) await walk(child);
      else if (e.name === "route.ts") files.push(child.pathname);
    }
  }
  await walk(root);
  let calls = 0;
  for (const f of files) {
    const src = await Deno.readTextFile(decodeURIComponent(f));
    for (const m of src.matchAll(/\b(generateObject|streamText)\(\{([\s\S]{0,400})/g)) {
      calls++;
      assert(/maxOutputTokens/.test(m[2]), `${f}: ${m[1]}( sin maxOutputTokens`);
    }
  }
  assert(calls >= 8, `se esperaban >= 8 llamadas y hay ${calls}`);
});

Deno.test("dashboard-ai cubre el refusal de los dos mapeos (content-filter del provider v2 y unknown del v4)", async () => {
  const src = await Deno.readTextFile(new URL("../../web/src/lib/dashboard-ai.ts", import.meta.url));
  assert(src.includes('"content-filter"') && src.includes('"unknown"'));
});
