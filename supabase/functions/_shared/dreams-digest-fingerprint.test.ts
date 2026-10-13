// _shared/dreams-digest-fingerprint.test.ts
// Correr con: deno test supabase/functions/_shared/dreams-digest-fingerprint.test.ts
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.0";
import { canSkipDigestRebuild, digestFingerprint } from "./dreams-digest-fingerprint.ts";

const ctx = { model: "claude-haiku-5-5", promptVersion: "1", maxWords: 900, operator: "Acme" };
const d = (path: string, content: string) => ({ path, content });

Deno.test("mismo set + mismo digest => mismo fingerprint, sin importar el orden de listado", async () => {
  const a = await digestFingerprint([d("/dreams/a.md", "A"), d("/dreams/b.md", "B")], "digest", ctx);
  const b = await digestFingerprint([d("/dreams/b.md", "B"), d("/dreams/a.md", "A")], "digest", ctx);
  assertEquals(a, b);
  assert(/^[0-9a-f]{64}$/.test(a));
});

Deno.test("cambia si se agrega, borra o EDITA un dream (mismo path, otro contenido)", async () => {
  const base = await digestFingerprint([d("/dreams/a.md", "A")], "x", ctx);
  assertNotEquals(base, await digestFingerprint([d("/dreams/a.md", "A"), d("/dreams/b.md", "B")], "x", ctx));
  assertNotEquals(base, await digestFingerprint([], "x", ctx));
  assertNotEquals(base, await digestFingerprint([d("/dreams/a.md", "A editado")], "x", ctx));
});

Deno.test("cambia si alguien edita el digest a mano (el digest previo es parte de la entrada)", async () => {
  const a = await digestFingerprint([d("/dreams/a.md", "A")], "digest v1", ctx);
  assertNotEquals(a, await digestFingerprint([d("/dreams/a.md", "A")], "digest editado", ctx));
});

Deno.test("cambia si cambia el modelo, la versión del prompt o el tope de palabras", async () => {
  const a = await digestFingerprint([d("/dreams/a.md", "A")], "x", ctx);
  assertNotEquals(a, await digestFingerprint([d("/dreams/a.md", "A")], "x", { ...ctx, model: "claude-sonnet-4-6" }));
  assertNotEquals(a, await digestFingerprint([d("/dreams/a.md", "A")], "x", { ...ctx, promptVersion: "2" }));
  assertNotEquals(a, await digestFingerprint([d("/dreams/a.md", "A")], "x", { ...ctx, maxWords: 500 }));
  // OPERATOR_NAME se interpola en el prompt de consolidación: renombrar al operador debe reconstruir.
  assertNotEquals(a, await digestFingerprint([d("/dreams/a.md", "A")], "x", { ...ctx, operator: "Otra Marca" }));
});

Deno.test("no hay colisión por concatenación (path/contenido ambiguos)", async () => {
  const a = await digestFingerprint([d("/dreams/a.md", "bc")], "", ctx);
  const b = await digestFingerprint([d("/dreams/a.mdb", "c")], "", ctx);
  assertNotEquals(a, b);
});

Deno.test("canSkipDigestRebuild: solo si coincide el fingerprint guardado Y no hay exceso por archivar", () => {
  assertEquals(canSkipDigestRebuild({ stored: "abc", current: "abc", activeCount: 10, maxActive: 60 }), true);
  assertEquals(canSkipDigestRebuild({ stored: "abc", current: "abd", activeCount: 10, maxActive: 60 }), false);
  assertEquals(canSkipDigestRebuild({ stored: undefined, current: "abc", activeCount: 10, maxActive: 60 }), false);
  assertEquals(canSkipDigestRebuild({ stored: "", current: "abc", activeCount: 10, maxActive: 60 }), false);
  // Backlog > maxActive: el archivado va por tandas y debe seguir corriendo aunque nada cambie.
  assertEquals(canSkipDigestRebuild({ stored: "abc", current: "abc", activeCount: 61, maxActive: 60 }), false);
  assertEquals(canSkipDigestRebuild({ stored: "abc", current: "abc", activeCount: 60, maxActive: 60 }), true);
});
