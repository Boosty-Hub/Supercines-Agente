// supabase/tests/dashboard-ai-body.test.ts
// Captura el body HTTP REAL que el AI SDK (las MISMAS versiones que usa web/:
// ai@5.0.267 / @ai-sdk/anthropic@2.0.106; si web/package.json las cambia, este
// test debe actualizarse con ellas) arma para /v1/messages cuando se usa el
// `dashboardModel` REAL de web/src/lib/dashboard-ai.ts, y afirma lo que Haiku 5.5
// exige / lo que el provider hace mal con él:
//  - sin temperature / top_p / top_k (ai@4 mandaba `temperature: 0` y Haiku 5.5
//    lo rechazaba con 400);
//  - con output_config.effort NATIVO (providerOptions.anthropic.effort), solo si
//    el modelo lo soporta;
//  - con max_tokens acotado: @ai-sdk/anthropic@2.0.106 no conoce claude-haiku-5-5
//    y sin tope explícito manda max_tokens=128000.
// Correr con: deno test --node-modules-dir=auto --allow-read --allow-env supabase/tests/dashboard-ai-body.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { DASHBOARD_TASKS, aiErrorMessage, dashboardModel } from "../../web/src/lib/dashboard-ai.ts";

type Captured = Record<string, unknown> & { __headers?: Record<string, string> };

function interceptor(captured: Captured[], reply: unknown): typeof fetch {
  return (_input, init) => {
    const body = JSON.parse(init!.body as string) as Captured;
    body.__headers = Object.fromEntries(new Headers(init!.headers as HeadersInit).entries());
    captured.push(body);
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

/** Tope duro de max_tokens para cualquier ruta del dashboard (el provider mandaría 128000). */
const MAX_TOKENS_CEILING = 16000;

for (const model of ["claude-haiku-5-5", "claude-opus-4-8"]) {
  for (const [name, task] of Object.entries(DASHBOARD_TASKS)) {
    Deno.test(`${model} / ${name}: generateObject y generateText sin sampling, con effort nativo y max_tokens acotado`, async () => {
      const captured: Captured[] = [];
      await generateObject({
        model: dashboardModel("k", task, { model, fetch: interceptor(captured, toolReply(model)) }),
        schema: z.object({ ok: z.boolean() }),
        prompt: "x",
      });
      await generateText({
        model: dashboardModel("k", task, { model, fetch: interceptor(captured, textReply(model)) }),
        prompt: "x",
      });

      assertEquals(captured.length, 2);
      for (const body of captured) {
        for (const k of ["temperature", "top_p", "top_k"]) assert(!(k in body), `${k} presente en ${JSON.stringify(body)}`);
        assertEquals(body.model, model);
        assertEquals((body.output_config as { effort: string }).effort, task.effort);
        assertEquals(body.max_tokens, task.maxOutputTokens);
        assert(
          (body.max_tokens as number) <= MAX_TOKENS_CEILING,
          `max_tokens=${body.max_tokens} supera ${MAX_TOKENS_CEILING} (¿volvió el default de 128000?)`,
        );
      }
    });
  }
}

Deno.test("todas las tareas del dashboard declaran un tope de salida razonable", () => {
  for (const [name, task] of Object.entries(DASHBOARD_TASKS)) {
    assert(task.maxOutputTokens > 0 && task.maxOutputTokens <= MAX_TOKENS_CEILING, `${name}: ${task.maxOutputTokens}`);
  }
});

Deno.test("el tope por llamada (maxOutputTokens explícito) le gana al de la tarea", async () => {
  const captured: Captured[] = [];
  const model = "claude-haiku-5-5";
  await generateText({
    model: dashboardModel("k", DASHBOARD_TASKS.filters, { model, fetch: interceptor(captured, textReply(model)) }),
    prompt: "x",
    maxOutputTokens: 123,
  });
  assertEquals(captured[0].max_tokens, 123);
});

Deno.test("SIN el middleware el provider mandaría max_tokens=128000 para Haiku 5.5 (por eso el tope explícito)", async () => {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const captured: Captured[] = [];
  const anthropic = createAnthropic({ apiKey: "k", fetch: interceptor(captured, textReply("claude-haiku-5-5")) });
  await generateText({ model: anthropic("claude-haiku-5-5"), prompt: "x" });
  assert(!("temperature" in captured[0]));
  assert(!("output_config" in captured[0]));
  assertEquals(captured[0].max_tokens, 128000);
});

Deno.test("claude-haiku-4-5: NO lleva effort (lo rechaza con 400) pero sí el tope", async () => {
  const captured: Captured[] = [];
  const model = "claude-haiku-4-5";
  await generateText({
    model: dashboardModel("k", DASHBOARD_TASKS.grader, { model, fetch: interceptor(captured, textReply(model)) }),
    prompt: "x",
  });
  assert(!("output_config" in captured[0]));
  assertEquals(captured[0].max_tokens, DASHBOARD_TASKS.grader.maxOutputTokens);
});

Deno.test("aiErrorMessage: el rechazo (content-filter en provider v2, unknown por compat) y el corte dan mensajes claros", async () => {
  const model = "claude-haiku-5-5";
  const refusal = { ...toolReply(model), stop_reason: "refusal", content: [] };
  const truncated = { ...toolReply(model), stop_reason: "max_tokens", content: [{ type: "tool_use", id: "t", name: "json", input: {} }] };
  const run = async (reply: unknown) => {
    const captured: Captured[] = [];
    try {
      await generateObject({
        model: dashboardModel("k", DASHBOARD_TASKS.filters, { model, fetch: interceptor(captured, reply) }),
        schema: z.object({ ok: z.boolean() }),
        prompt: "x",
      });
    } catch (err) {
      return aiErrorMessage(err);
    }
    throw new Error("debía fallar");
  };
  assert((await run(refusal)).includes("declinado"));
  assert((await run(truncated)).includes("longitud"));
});

Deno.test("los pins de deno.json (imports de este test) coinciden con web/package.json", () => {
  const deno = JSON.parse(Deno.readTextFileSync(new URL("../../deno.json", import.meta.url))) as { imports: Record<string, string> };
  const web = JSON.parse(Deno.readTextFileSync(new URL("../../web/package.json", import.meta.url))) as { dependencies: Record<string, string> };
  for (const name of ["ai", "@ai-sdk/anthropic"]) {
    assertEquals(deno.imports[name], `npm:${name}@${web.dependencies[name]}`, `${name}: pin distinto entre deno.json y web/package.json`);
  }
  // zod usa rango en web (^3.25.76): deno.json fija esa misma base.
  assertEquals(deno.imports.zod, `npm:zod@${web.dependencies.zod.replace(/^\^/, "")}`);
});

Deno.test("el effort viaja nativo (output_config + header beta del provider), sin reescribir el body", async () => {
  const captured: Captured[] = [];
  const model = "claude-haiku-5-5";
  await generateText({
    model: dashboardModel("k", DASHBOARD_TASKS.filters, { model, fetch: interceptor(captured, textReply(model)) }),
    prompt: "x",
  });
  assertEquals((captured[0].output_config as { effort: string }).effort, "low");
  assert(captured[0].__headers?.["anthropic-beta"]?.includes("effort-"), JSON.stringify(captured[0].__headers));
});
