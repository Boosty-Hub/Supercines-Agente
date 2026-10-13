// _shared/dreams-consolidation.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/dreams-consolidation.test.ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { buildConsolidationPrompt } from "./dreams-consolidation.ts";
import { digestFingerprint } from "./dreams-digest-fingerprint.ts";

const d = (path: string, content: string) => ({ path, content });
const base = { operator: "Acme", archived: "", maxWords: 900 };

Deno.test("el digest se arma con el resumen archivado + los activos, y nada más", () => {
  const p = buildConsolidationPrompt({
    ...base,
    purpose: "digest",
    archived: "Regla antigua: saludar por el nombre.",
    dreams: [d("/dreams/a.md", "Regla A"), d("/dreams/b.md", "Regla B")],
  });
  assertStringIncludes(p, "Regla antigua: saludar por el nombre.");
  assertStringIncludes(p, "### /dreams/a.md\nRegla A");
  assertStringIncludes(p, "### /dreams/b.md\nRegla B");
  assertStringIncludes(p, "DIGEST NUEVO");
});

Deno.test("BORRAR un dream activo lo saca del digest: su regla no puede reaparecer por otro camino", () => {
  const antes = buildConsolidationPrompt({
    ...base,
    purpose: "digest",
    dreams: [d("/dreams/a.md", "No prometas descuentos"), d("/dreams/b.md", "Pide la cédula")],
  });
  assertStringIncludes(antes, "No prometas descuentos");
  // el operador borra el dream A: el siguiente rebuild solo ve B
  const despues = buildConsolidationPrompt({ ...base, purpose: "digest", dreams: [d("/dreams/b.md", "Pide la cédula")] });
  assert(!despues.includes("No prometas descuentos"), "la regla borrada sigue en el prompt");
  // y no hay ningún parámetro por el que un digest anterior pueda colarse
  assertEquals(buildConsolidationPrompt.length, 1);
});

Deno.test("el archivado consolida los antiguos que salen de la lista, con su propio objetivo", () => {
  const p = buildConsolidationPrompt({
    ...base,
    purpose: "archive",
    archived: "Resumen previo",
    dreams: [d("/dreams/viejo.md", "Regla vieja")],
  });
  assertStringIncludes(p, "RESUMEN ARCHIVADO NUEVO");
  assertStringIncludes(p, "APRENDIZAJES A ARCHIVAR");
  assertStringIncludes(p, "Resumen previo");
});

Deno.test("sin archivado ni activos el prompt lo dice, no inventa contenido", () => {
  const p = buildConsolidationPrompt({ ...base, purpose: "digest", dreams: [] });
  assertEquals((p.match(/\(ninguno\)/g) ?? []).length, 2);
});

Deno.test("el tope de palabras viaja al prompt", () => {
  assertStringIncludes(buildConsolidationPrompt({ ...base, purpose: "digest", maxWords: 1500, dreams: [] }), "máximo 1500 palabras");
});

Deno.test("el fingerprint incluye el resumen archivado: cambiarlo fuerza un rebuild", async () => {
  const ctx = { model: "m", promptVersion: "2", maxWords: 900, operator: "Acme", archived: "uno" };
  const a = await digestFingerprint([d("/dreams/a.md", "A")], "digest", ctx);
  assert(a !== (await digestFingerprint([d("/dreams/a.md", "A")], "digest", { ...ctx, archived: "dos" })));
  assertEquals(a, await digestFingerprint([d("/dreams/a.md", "A")], "digest", ctx));
});
