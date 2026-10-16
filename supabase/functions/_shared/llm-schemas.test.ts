// Guardia de structured output: todo objeto de un json_schema declara
// additionalProperties:false (si no, la API responde 400 y el llamador queda roto en
// silencio: ver llm-schemas.ts) y ningún json_schema se escribe inline fuera de ese módulo.
// Correr con: deno test --allow-read supabase/functions/_shared/llm-schemas.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import * as schemas from "./llm-schemas.ts";
import { openObjectPaths, type JsonSchema } from "./llm-schemas.ts";

const ALL: Record<string, JsonSchema> = {
  GRADER_PASS_FAIL_SCHEMA: schemas.GRADER_PASS_FAIL_SCHEMA,
  GRADER_SCORE_SCHEMA: schemas.GRADER_SCORE_SCHEMA,
  DREAMS_LEARNINGS_SCHEMA: schemas.DREAMS_LEARNINGS_SCHEMA,
  classifySchema: schemas.classifySchema(["ventas", "soporte"]),
};

for (const [name, schema] of Object.entries(ALL)) {
  Deno.test(`${name}: todos sus objetos cierran con additionalProperties:false`, () => {
    assertEquals(openObjectPaths(schema), []);
  });
  Deno.test(`${name}: todas sus propiedades son required`, () => {
    const walk = (s: JsonSchema, path: string) => {
      if (s.properties) {
        assertEquals([...(s.required ?? [])].sort(), Object.keys(s.properties).sort(), path);
        for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`);
      }
      if (s.items) walk(s.items, `${path}[]`);
    };
    walk(schema, "$");
  });
}

Deno.test("todo schema exportado está en la tabla de la guardia", () => {
  const exported = Object.keys(schemas).filter((k) => k.endsWith("_SCHEMA") || k.endsWith("Schema"));
  assertEquals(exported.sort(), Object.keys(ALL).sort());
});

Deno.test("openObjectPaths detecta objetos abiertos en cualquier nivel", () => {
  assertEquals(openObjectPaths({ type: "object", properties: { a: { type: "string" } } }), ["$"]);
  assertEquals(
    openObjectPaths({
      type: "object",
      additionalProperties: false,
      properties: { l: { type: "array", items: { type: "object", properties: { x: { type: "object", additionalProperties: false } } } } },
    }),
    ["$.l[]"],
  );
  assertEquals(openObjectPaths({ anyOf: [{ type: "object" }] }), ["$.anyOf[0]"]);
});

function sourceFiles(dir: URL): URL[] {
  const out: URL[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) out.push(...sourceFiles(u));
    else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.ts$|\.generated\.ts$/.test(e.name)) out.push(u);
  }
  return out;
}

Deno.test("ningún json_schema de output_config se escribe inline fuera de llm-schemas.ts", () => {
  const roots = [new URL("../", import.meta.url), new URL("../../../web/src/", import.meta.url)];
  let checked = 0;
  for (const root of roots) {
    try {
      Deno.statSync(root);
    } catch {
      continue;
    }
    for (const f of sourceFiles(root)) {
      if (f.pathname.endsWith("/_shared/llm-schemas.ts")) continue;
      const src = Deno.readTextFileSync(f);
      for (const m of src.matchAll(/type:\s*["']json_schema["']/g)) {
        checked++;
        const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 200);
        // `schema: X` o el shorthand `schema` (una variable): nunca `schema: {`.
        const value = /\bschema\b\s*(:\s*(\S)|[,}\s])/.exec(after);
        assert(value, `${f.pathname}: json_schema sin schema`);
        assert(value[2] !== "{", `${f.pathname}: json_schema inline; declaralo en _shared/llm-schemas.ts`);
        assert(src.includes('/_shared/llm-schemas.ts"'), `${f.pathname}: el schema debe venir de llm-schemas.ts`);
      }
    }
  }
  assert(checked >= 3, `se esperaban los 3 usos conocidos (grader, dreams, clasificador); hubo ${checked}`);
});
