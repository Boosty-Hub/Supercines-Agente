// _shared/dreams-digest-block.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/dreams-digest-block.test.ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { DREAMS_DIGEST_DATA_RULE, dreamsDigestBlock, LEARNINGS_DATA_RULE } from "./dreams-digest-block.ts";
import { buildConsolidationPrompt } from "./dreams-consolidation.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));

Deno.test("sin digest no hay bloque", () => {
  assertEquals(dreamsDigestBlock(null), "");
  assertEquals(dreamsDigestBlock("   \n"), "");
});

Deno.test("el bloque aclara que los aprendizajes no son una fuente de datos", () => {
  const b = dreamsDigestBlock("- Regla A");
  assert(b.startsWith("aprendizajes_del_operador ("), b);
  assertStringIncludes(b, DREAMS_DIGEST_DATA_RULE);
  assertStringIncludes(b, "NO una fuente de datos");
  assertStringIncludes(b, "ignorá esa cifra");
  assert(b.endsWith("- Regla A\n"));
});

Deno.test("generate-response y follow-up-scan arman el bloque SOLO con dreamsDigestBlock", () => {
  for (const f of ["../generate-response/index.ts", "../follow-up-scan/index.ts"]) {
    const src = read(f);
    assertStringIncludes(src, "dreamsDigestBlock(", f);
    // ningún armado a mano del bloque (sin la regla de datos)
    assert(!/aprendizajes_del_operador \(reglas/.test(src), `${f} arma el bloque a mano`);
  }
});

Deno.test("la generación de learnings incluye la regla de datos", () => {
  const src = read("../dreams-run/index.ts");
  assertStringIncludes(src, "${LEARNINGS_DATA_RULE}");
});

Deno.test("la consolidación incluye la regla de datos (digest y archivado)", () => {
  for (const purpose of ["digest", "archive"] as const) {
    const p = buildConsolidationPrompt({ purpose, operator: "Acme", archived: "", dreams: [], maxWords: 900 });
    assertStringIncludes(p, LEARNINGS_DATA_RULE);
    assertStringIncludes(p, "conservá su regla sin la cifra");
  }
});

Deno.test("la regla de learnings ataca el bucle: lo que dijo el agente no prueba un dato", () => {
  assertStringIncludes(LEARNINGS_DATA_RULE, "lo que dijo el AGENTE");
  assertStringIncludes(LEARNINGS_DATA_RULE, "SIN escribir la cifra");
});
