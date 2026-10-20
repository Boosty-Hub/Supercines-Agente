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
  assertStringIncludes(b, "ignora esa cifra");
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

Deno.test("la generación de learnings usa el prompt compartido (con la regla de datos)", () => {
  const src = read("../dreams-run/index.ts");
  assertStringIncludes(src, "buildDreamPrompt(");
  assert(!/function dreamPrompt\(/.test(src), "dreams-run arma el prompt a mano");
  assertStringIncludes(read("./dreams-generation.ts"), "${LEARNINGS_DATA_RULE}");
});

Deno.test("el archivado incluye la regla de datos", () => {
  const p = buildConsolidationPrompt({ operator: "Acme", archived: "", dreams: [], maxWords: 900 });
  assertStringIncludes(p, LEARNINGS_DATA_RULE);
  assertStringIncludes(p, "conserva su regla sin el dato");
});

Deno.test("la regla de learnings ataca el bucle: lo que dijo el agente no prueba un dato", () => {
  assertStringIncludes(LEARNINGS_DATA_RULE, "lo que dijo el AGENTE");
  assertStringIncludes(LEARNINGS_DATA_RULE, "SIN escribir el dato");
});

Deno.test("la regla cubre TODO dato del negocio, no solo cifras: los aprendizajes son de CONDUCTA", () => {
  for (const tipo of [
    "precio", "estado", "causa", "correo", "teléfono", "enlace", "horario", "fecha", "requisito",
    "disponibilidad", "política", "promoción",
  ]) {
    assertStringIncludes(LEARNINGS_DATA_RULE, tipo, tipo);
  }
  assertStringIncludes(LEARNINGS_DATA_RULE, "CONDUCTA");
  for (const fuente of ["system prompt", "KB", "situaciones", "promociones", "herramientas"]) {
    assertStringIncludes(LEARNINGS_DATA_RULE, fuente, fuente);
  }
});

Deno.test("la aclaración al agente también cubre todo dato del negocio", () => {
  for (const tipo of ["horarios", "correos", "teléfonos", "enlaces", "estado", "promociones"]) {
    assertStringIncludes(DREAMS_DIGEST_DATA_RULE, tipo, tipo);
  }
});

Deno.test("un digest ya guardado con el marcador de dato llega al agente con la frase natural", () => {
  // Digests persistidos antes del corte (SuperCines, oct-2026): no esperan al próximo rebuild.
  const b = dreamsDigestBlock(
    "- Si no tienes confirmado un dato de la KB, dilo sin inventar y remite a [dato: tomarlo de la fuente oficial] o al correo de gerencia.",
  );
  assert(!b.includes("[dato"), b);
  assertStringIncludes(b, "remite a los canales oficiales o al correo de gerencia");
});

Deno.test("defensa al inyectar: una viñeta con correo/URL/teléfono/monto no llega al agente; las reglas sin datos sí", () => {
  const b = dreamsDigestBlock([
    "## Errores a no repetir",
    "- Escribe a ventas@x.com.",
    "- Visita https://x.com/promo.",
    "- Llama al 0414-1234567.",
    "- Cuesta $25.",
    "- No digas que abre el domingo; si preguntan, aclara que está cerrado y cuándo abre.",
    "- Atiende emergencias 24/7; llama ahora al lead.",
    "- Responde en 2-3 oraciones, de 9 a 6 solo si figura en tu prompt.",
  ].join("\n"));
  for (const bad of ["ventas@x.com", "https://x.com", "0414-1234567", "$25"]) assert(!b.includes(bad), bad);
  assertStringIncludes(b, "- No digas que abre el domingo; si preguntan, aclara que está cerrado y cuándo abre.");
  assertStringIncludes(b, "- Atiende emergencias 24/7; llama ahora al lead.");
  assertStringIncludes(b, "2-3 oraciones, de 9 a 6");
});

Deno.test("defensa al inyectar: si todo eran datos, no hay bloque", () => {
  assertEquals(dreamsDigestBlock("## Errores a no repetir\n- Escribe a ventas@x.com."), "");
});
