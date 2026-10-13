// Tests de la clave de montaje de formularios (B-C1).
// Correr con: cd web && node --test src/lib/form-key.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import { formKey } from "./form-key.ts";

test("mismos valores iniciales → misma clave (no re-monta de más)", () => {
  assert.equal(formKey("op", "ag", "label", "prompt"), formKey("op", "ag", "label", "prompt"));
});

test("cambia el prompt (import_live) → cambia la clave", () => {
  assert.notEqual(formKey("op", "ag", "label", "viejo"), formKey("op", "ag", "label", "importado"));
});

test("cambia cualquier otro valor inicial → cambia la clave", () => {
  const base = formKey("op", "ag", "label", "p");
  assert.notEqual(base, formKey("op2", "ag", "label", "p"));
  assert.notEqual(base, formKey("op", "ag2", "label", "p"));
  assert.notEqual(base, formKey("op", "ag", "label2", "p"));
});

test("los límites entre valores cuentan: ('ab','c') != ('a','bc')", () => {
  assert.notEqual(formKey("ab", "c"), formKey("a", "bc"));
});

test("null/undefined equivalen a vacío y no rompen", () => {
  assert.equal(formKey(null, undefined), formKey("", ""));
});

test("un formulario con useState(initial) renderiza el valor de la config vigente al cambiar la key", () => {
  // Mismo patrón que AgentForm: useState(initial.systemPrompt).
  function Form({ initial }: { initial: string }) {
    const [value] = useState(initial);
    return createElement("textarea", { defaultValue: value, readOnly: true });
  }
  const html = (initial: string) => renderToString(createElement(Form, { key: formKey(initial), initial }));
  assert.match(html("viejo"), /viejo/);
  assert.match(html("importado"), /importado/);
  assert.doesNotMatch(html("importado"), /viejo/);
});
