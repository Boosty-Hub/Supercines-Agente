// Tests de la inversa de la sustitución de placeholders (W6).
// Correr con: cd web && node --test src/lib/prompt-placeholders.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeholderize } from "./prompt-placeholders.ts";
import { substitutePlaceholders, type PlaceholderValues } from "./agent-prompt.ts";

const V: PlaceholderValues = { operatorName: "Acme Store", masterStoreName: "acme-master", leadsStoreName: "acme-leads" };
const RAW =
  "Sos el asistente de {{OPERATOR_NAME}}.\nLeé {{MASTER_PATH}}/voice/ y escribí en {{LEADS_PATH}}/<id>/learnings.md.\nStores: {{MEMORY_STORE_MASTER}} y {{MEMORY_STORE_LEADS}}.";

const roundtrip = (raw: string, v: PlaceholderValues) => {
  const sub = substitutePlaceholders(raw, v);
  const p = placeholderize(sub, v);
  return { sub, p, again: substitutePlaceholders(p.text, v) };
};

test("ida y vuelta sin ambigüedad: sustituir → re-placeholderizar devuelve el original", () => {
  const { sub, p, again } = roundtrip(RAW, V);
  assert.notEqual(sub, RAW);
  assert.equal(p.text, RAW);
  assert.equal(again, sub);
  assert.deepEqual(p.ambiguous, []);
});

test("las rutas ganan al nombre del store que contienen (más largo primero)", () => {
  const { p } = roundtrip("{{MASTER_PATH}} {{MEMORY_STORE_MASTER}}", V);
  assert.equal(p.text, "{{MASTER_PATH}} {{MEMORY_STORE_MASTER}}");
  const counts = Object.fromEntries(p.replaced.map((r) => [r.placeholder, r.count]));
  assert.equal(counts["{{MASTER_PATH}}"], 1);
  assert.equal(counts["{{MEMORY_STORE_MASTER}}"], 1);
});

test("un valor que contiene a otro (operador 'Acme Store' vs store 'Acme'): sin reemplazos cruzados", () => {
  const v: PlaceholderValues = { operatorName: "Acme Store", masterStoreName: "Acme", leadsStoreName: "Acme-leads" };
  const raw = "{{OPERATOR_NAME}} / {{MEMORY_STORE_MASTER}} / {{LEADS_PATH}} / {{MEMORY_STORE_LEADS}}";
  const { p, again, sub } = roundtrip(raw, v);
  assert.equal(p.text, raw);
  assert.equal(again, sub);
});

test("no toca coincidencias dentro de otra palabra", () => {
  const txt = "Acme Stores y acme-masterful; /mnt/memory/acme-master2";
  const p = placeholderize(txt, V);
  assert.equal(p.text, txt);
  assert.deepEqual(p.replaced, []);
});

test("AMBIGUO: operador corto (2 letras) no se re-placeholderiza y se informa", () => {
  const v: PlaceholderValues = { operatorName: "TI", masterStoreName: "acme-master", leadsStoreName: "acme-leads" };
  const raw = "Somos {{OPERATOR_NAME}}; el TI de la tienda y el TI del banco.";
  const sub = substitutePlaceholders(raw, v);
  const p = placeholderize(sub, v);
  assert.equal(p.text, sub);
  assert.deepEqual(p.ambiguous, [{ placeholder: "{{OPERATOR_NAME}}", value: "TI", count: 3, reason: "short" }]);
  assert.equal(substitutePlaceholders(p.text, v), sub);
});

test("AMBIGUO: los defaults (el operador / master / leads) son palabras comunes: no se tocan", () => {
  const v: PlaceholderValues = { operatorName: "el operador", masterStoreName: "master", leadsStoreName: "leads" };
  const sub = substitutePlaceholders(
    "{{OPERATOR_NAME}} guarda en {{LEADS_PATH}} y {{MEMORY_STORE_LEADS}}; el master manda y los leads esperan.",
    v,
  );
  const p = placeholderize(sub, v);
  // las rutas SÍ son inequívocas; los nombres sueltos no
  assert.match(p.text, /\{\{LEADS_PATH\}\}/);
  assert.match(p.text, /el operador guarda/);
  assert.ok(p.ambiguous.some((a) => a.placeholder === "{{OPERATOR_NAME}}" && a.reason === "common_word"));
  assert.ok(p.ambiguous.some((a) => a.placeholder === "{{MEMORY_STORE_LEADS}}" && a.reason === "common_word"));
  assert.equal(substitutePlaceholders(p.text, v), sub);
});

test("AMBIGUO: dos placeholders con el mismo valor no se pueden distinguir", () => {
  const v: PlaceholderValues = { operatorName: "Acme Store", masterStoreName: "acme-kb", leadsStoreName: "acme-kb" };
  const sub = substitutePlaceholders("{{MEMORY_STORE_MASTER}} {{MEMORY_STORE_LEADS}} {{MASTER_PATH}}", v);
  const p = placeholderize(sub, v);
  assert.equal(p.text, sub);
  assert.ok(p.ambiguous.length > 0 && p.ambiguous.every((a) => a.reason === "shared_value"));
  assert.equal(substitutePlaceholders(p.text, v), sub);
});

test("el texto sin valores conocidos queda intacto", () => {
  const p = placeholderize("Texto libre sin nada.", V);
  assert.equal(p.text, "Texto libre sin nada.");
  assert.deepEqual(p.replaced, []);
  assert.deepEqual(p.ambiguous, []);
});

test("regex especiales en el valor se escapan (operador 'A+B (SA)')", () => {
  const v: PlaceholderValues = { operatorName: "A+B (SA)", masterStoreName: "acme-master", leadsStoreName: "acme-leads" };
  const { p, again, sub } = roundtrip("Hola {{OPERATOR_NAME}}!", v);
  assert.equal(p.text, "Hola {{OPERATOR_NAME}}!");
  assert.equal(again, sub);
});
