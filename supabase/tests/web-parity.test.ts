// supabase/tests/web-parity.test.ts
// (También cubre módulos web puros sin runner propio: agent-model.ts.)
// Paridad entre código que vive DUPLICADO a ambos lados de la frontera Deno/Node
// (los imports son incompatibles, no se puede compartir archivo). Vive FUERA de
// supabase/functions/ a propósito: importa de web/, y todo lo de _shared/ viaja
// en el bundle de deploy de las Edge Functions.
// Correr con: deno test --allow-read --node-modules-dir=none supabase/tests/web-parity.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { AI_PRICING, costUsd } from "../functions/_shared/ai-pricing.ts";
import { MODEL_DEFAULTS } from "../functions/_shared/models.ts";
import * as web from "../../web/src/lib/ai-pricing.ts";
import { ALLOWED_MODELS, MODEL_KEYS, MODEL_LABELS, MODEL_NAMES } from "../../web/src/lib/model-config.ts";
import { AGENT_EFFORT, agentModelMatches, agentModelParam } from "../../web/src/lib/agent-model.ts";

Deno.test("PARIDAD: la copia web de ai-pricing es idéntica a la de Edge", () => {
  assertEquals(web.AI_PRICING, AI_PRICING);
  assertEquals(web.CMA_RUNTIME_USD_PER_HOUR, 0.08);
  const rows = [
    { model: "claude-haiku-5-5", inputTokens: 100_001, outputTokens: 1234, cacheReadTokens: 5 },
    { model: "claude-haiku-5-5", inputTokens: 10, outputTokens: 20, cacheCreation5m: 30, cacheCreation1h: 40 },
    { model: "claude-haiku-5-5", inputTokens: 900_000, aggregated: true, runtimeMs: 60_000 },
    { model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 },
  ];
  for (const r of rows) assertEquals(web.costUsd(r), costUsd(r));
  assert(web.parsePricingOverride("{bad") === null);
});

Deno.test("los defaults de Edge coinciden con MODEL_KEYS de web", () => {
  assertEquals({ ...MODEL_DEFAULTS }, { ...MODEL_KEYS });
});

Deno.test("todo modelo asignable tiene tarifa y etiqueta (si no, costUsd daría 0 en silencio)", () => {
  for (const m of ALLOWED_MODELS) {
    if (!AI_PRICING[m]) throw new Error(`sin pricing: ${m}`);
    if (!MODEL_LABELS[m]) throw new Error(`sin label: ${m}`);
  }
  for (const m of Object.values(MODEL_DEFAULTS)) {
    if (!(ALLOWED_MODELS as readonly string[]).includes(m)) throw new Error(`default no permitido: ${m}`);
  }
});

Deno.test("todo modelo asignable tiene nombre corto", () => {
  for (const m of ALLOWED_MODELS) if (!MODEL_NAMES[m]) throw new Error(`sin nombre: ${m}`);
});


Deno.test("agentModelParam: effort explícito para modelos que lo soportan, string plano para Haiku 4.5", () => {
  assertEquals(agentModelParam("claude-haiku-5-5"), { id: "claude-haiku-5-5", effort: AGENT_EFFORT });
  assertEquals(agentModelParam("claude-sonnet-4-6"), { id: "claude-sonnet-4-6", effort: AGENT_EFFORT });
  assertEquals(agentModelParam("claude-haiku-4-5"), "claude-haiku-4-5");
});

Deno.test("agentModelMatches: compara contra el agente VIVO (string u objeto, effort string u {type})", () => {
  const want = agentModelParam("claude-haiku-5-5");
  assertEquals(agentModelMatches({ id: "claude-haiku-5-5", effort: "medium" }, want), true);
  assertEquals(agentModelMatches({ id: "claude-haiku-5-5", effort: { type: "medium" } }, want), true);
  assertEquals(agentModelMatches({ id: "claude-haiku-5-5", effort: "high" }, want), false);
  assertEquals(agentModelMatches({ id: "claude-haiku-5-5" }, want), false);
  assertEquals(agentModelMatches("claude-sonnet-4-6", want), false);
  assertEquals(agentModelMatches(undefined, want), false);
  // Haiku 4.5 no soporta effort: solo importa el id.
  assertEquals(agentModelMatches({ id: "claude-haiku-4-5", effort: null }, agentModelParam("claude-haiku-4-5")), true);
});

// El scaffold que se sincroniza al agente y el ejemplo de system prompt deben
// ser coherentes con el [CONTEXTO] (historial + digest de dreams ya vienen en el
// mensaje): pedirle al agente leer conversation.md o /dreams/ reintroduce el
// costo de tokens por respuesta que se eliminó.
Deno.test("CORE_SCAFFOLD y system-prompt.example no piden conversation.md ni leer /dreams/", async () => {
  const src = await Deno.readTextFile(new URL("../../web/src/lib/agent-prompt.ts", import.meta.url));
  const scaffold = src.slice(src.indexOf("export const CORE_SCAFFOLD"), src.indexOf("// Phrase per CRM tool"));
  assert(scaffold.length > 500, "no se encontró el scaffold");
  assert(!/conversation\.md/.test(scaffold));
  assert(!/dreams\//.test(scaffold));
  const example = await Deno.readTextFile(new URL("../../agent/system-prompt.example.md", import.meta.url));
  assert(!/conversation\.md/.test(example));
  assert(!/glob .*dreams/.test(example));
});

import { parseBudget as parseBudgetEdge } from "../functions/_shared/budget.ts";
import { parseBudget as parseBudgetWeb } from "../../web/src/lib/budget.ts";

Deno.test("PARIDAD: parseBudget web == Edge", () => {
  for (const v of [undefined, null, "", "0", "-1", "abc", "NaN", "Infinity", "1", "12.5", "1e3"]) {
    assertEquals(parseBudgetWeb(v), parseBudgetEdge(v), String(v));
  }
});
