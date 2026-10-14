// _shared/followup-variables.test.ts
// Variables de la plantilla de seguimiento: solo propiedades propias, mapa sin prototipo.
// Correr con: deno test --allow-read supabase/functions/_shared/followup-variables.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { resolveTemplateVariables } from "./followup-variables.ts";

Deno.test("todas las variables presentes → solo esas claves, con su texto", () => {
  const r = resolveTemplateVariables(` {"nombre":"Ana","monto":1500,"extra":"x"} `, ["nombre", "monto"]);
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals({ ...r.values }, { nombre: "Ana", monto: "1500" });
    assertEquals(Object.getPrototypeOf(r.values), null);
  }
});

Deno.test("JSON roto → invalid_json", () => {
  assertEquals(resolveTemplateVariables("{nombre:", ["nombre"]), { ok: false, reason: "invalid_json" });
});

Deno.test("sin bloque, bloque vacío, array o valor no-objeto → la primera variable falta", () => {
  for (const raw of [undefined, "", "  ", "[]", '"Ana"', "null", "3"]) {
    assertEquals(resolveTemplateVariables(raw, ["nombre"]), { ok: false, reason: "missing", name: "nombre" }, String(raw));
  }
});

Deno.test("sin variables en la plantilla → ok vacío aunque no haya bloque", () => {
  const r = resolveTemplateVariables(undefined, []);
  assertEquals(r.ok && Object.keys(r.values).length, 0);
});

Deno.test("vacía, solo espacios, booleana u objeto → falta", () => {
  for (const v of ['""', '"  "', "true", "{}", "null"]) {
    assertEquals(resolveTemplateVariables(`{"nombre":${v}}`, ["nombre"]).ok, false, v);
  }
});

for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
  Deno.test(`variable "${name}" que el agente NO completó → falta (no resuelve a lo heredado)`, () => {
    assertEquals(resolveTemplateVariables(`{"otra":"x"}`, [name]), { ok: false, reason: "missing", name });
  });
}

Deno.test('"__proto__" que el agente SÍ completó es una propiedad propia: se usa su texto, sin tocar prototipos', () => {
  const r = resolveTemplateVariables(`{"__proto__":"hola","constructor":"chau"}`, ["__proto__", "constructor"]);
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(Object.hasOwn(r.values, "__proto__"), true);
    assertEquals(r.values["__proto__"], "hola");
    assertEquals(r.values["constructor"], "chau");
    assertEquals(Object.getPrototypeOf(r.values), null);
  }
  // Object.prototype no quedó contaminado.
  assertEquals(({} as Record<string, unknown>)["hola"], undefined);
});

Deno.test('un "__proto__" objeto en el JSON no inyecta variables heredadas', () => {
  assertEquals(resolveTemplateVariables(`{"__proto__":{"nombre":"inyectada"}}`, ["nombre"]), {
    ok: false,
    reason: "missing",
    name: "nombre",
  });
});
