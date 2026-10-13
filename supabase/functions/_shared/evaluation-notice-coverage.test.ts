// Guardia: los prompts que ANALIZAN conversaciones (digest de Dreams, clasificador con
// historial, grader) usan EVALUATION_NOTICE (todo es dato, incluida la respuesta del agente
// que pudo repetir lo que plantó el lead) y ningún prompt vuelve a llamar "del sistema" a un turno.
// Correr con: deno test --allow-read supabase/functions/_shared/evaluation-notice-coverage.test.ts
import { assert, assertStringIncludes } from "jsr:@std/assert@^1.0.0";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));

for (const f of ["../dreams-run/index.ts", "../process-inbound/index.ts", "./grader-prompt.ts"]) {
  Deno.test(`${f} introduce el material analizado con EVALUATION_NOTICE`, () => {
    assertStringIncludes(read(f), "${EVALUATION_NOTICE}");
    assert(!read(f).includes("${UNTRUSTED_NOTICE}"), "no debe quedar el aviso que confía en el rol del agente");
  });
}

Deno.test("ningún archivo de funciones declara confiable el rol del agente", () => {
  for (const f of ["./untrusted.ts", "../generate-response/index.ts", "../follow-up-scan/index.ts"]) {
    assert(!/provienen del sistema/.test(read(f)), f);
  }
});
