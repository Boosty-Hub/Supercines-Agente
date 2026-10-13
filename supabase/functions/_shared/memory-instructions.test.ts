// _shared/memory-instructions.test.ts
// Correr con: deno test supabase/functions/_shared/memory-instructions.test.ts
//
// Guardarraíl contra la regresión que costó tokens en CADA respuesta: las
// instrucciones de los Memory Stores no pueden volver a pedirle al agente que
// lea/reescriba conversation.md (el historial viaja determinístico en el
// [CONTEXTO]) ni que lea /dreams/ (viaja como digest en el [CONTEXTO]).
import { assert, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { leadsStoreInstructions, MASTER_STORE_INSTRUCTIONS } from "./memory-instructions.ts";

Deno.test("leads: solo learnings.md; nunca conversation.md como algo a leer/escribir", () => {
  const t = leadsStoreInstructions("lead-123");
  assertStringIncludes(t, "/lead-123/learnings.md");
  assertStringIncludes(t, "lead-123");
  // conversation.md solo puede aparecer para PROHIBIR su uso.
  for (const m of t.matchAll(/conversation\.md/g)) {
    const around = t.slice(Math.max(0, m.index! - 80), m.index! + 80);
    assert(/no |nunca|ya viene/i.test(around), `menciona conversation.md sin prohibirlo: ${around}`);
  }
  assertStringIncludes(t, "historial reciente");
});

Deno.test("leads: permite no escribir nada cuando no hay nada duradero", () => {
  assertStringIncludes(leadsStoreInstructions("x"), "no escribas nada");
});

Deno.test("master: /dreams/ se menciona solo para NO leerlo; el digest viene en el contexto", () => {
  const t = MASTER_STORE_INSTRUCTIONS;
  assertStringIncludes(t, "/dreams/");
  assert(/NO (lo )?leas/i.test(t));
  assertStringIncludes(t, "aprendizajes_del_operador");
});

Deno.test("master: voz solo si aplica, search_kb para datos factuales", () => {
  assertStringIncludes(MASTER_STORE_INSTRUCTIONS, "/voice/");
  assertStringIncludes(MASTER_STORE_INSTRUCTIONS, "search_kb");
  assert(!/antes de redactar/i.test(MASTER_STORE_INSTRUCTIONS), "no pedir lectura incondicional antes de redactar");
});
