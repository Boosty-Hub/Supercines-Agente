// Tests de B-W3 (restitución de {{TOOLS_LIST}} al importar el vivo) y B-S2 (scaffold al inicio).
// Correr con: cd web && node --test src/lib/tools-list-import.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSystem, renderToolsList, substitutePlaceholders, type AgentToolRow, type PlaceholderValues } from "./agent-prompt.ts";
import { placeholderize } from "./prompt-placeholders.ts";
import { detectPromptConflict, extractOperatorPrompt, extractScaffold } from "./agent-prompt-sync.ts";

const V: PlaceholderValues = { operatorName: "Acme Store", masterStoreName: "acme-master", leadsStoreName: "acme-leads" };
const toolRow = (name: string, description: string) => ({ name, description }) as AgentToolRow;

// ─── B-W3: {{TOOLS_LIST}} ───

test("{{TOOLS_LIST}} se restituye por coincidencia exacta del bloque sustituido", () => {
  const rows = [toolRow("consultar_stock", "Consulta el stock"), toolRow("cotizar", "Calcula una cotización")];
  const raw = "Sos de {{OPERATOR_NAME}}.\n{{TOOLS_LIST}}\nUsá {{MASTER_PATH}}/voice/.";
  const sub = substitutePlaceholders(raw, V, rows);
  assert.match(sub, /Herramientas externas disponibles: consultar_stock — Consulta el stock; cotizar — Calcula/);
  const p = placeholderize(sub, V, { toolsList: renderToolsList(rows) });
  assert.equal(p.text, raw);
  assert.equal(p.replaced.find((r) => r.placeholder === "{{TOOLS_LIST}}")?.count, 1);
  assert.deepEqual(p.ambiguous, []);
});

test("el bloque de herramientas gana aunque contenga el nombre del operador o una ruta", () => {
  const rows = [toolRow("avisar", "Avisa a Acme Store y escribe en /mnt/memory/acme-leads")];
  const raw = "{{TOOLS_LIST}} / {{OPERATOR_NAME}}";
  const sub = substitutePlaceholders(raw, V, rows);
  const p = placeholderize(sub, V, { toolsList: renderToolsList(rows) });
  assert.equal(p.text, raw);
});

test("sin herramientas HTTP (bloque vacío) no se inventa ningún reemplazo de TOOLS_LIST", () => {
  assert.equal(renderToolsList([]), "");
  const p = placeholderize("Hola Acme Store", V, { toolsList: "" });
  assert.equal(p.text, "Hola {{OPERATOR_NAME}}");
  assert.ok(!p.replaced.some((r) => r.placeholder === "{{TOOLS_LIST}}"));
});

test("sin la opción toolsList el comportamiento previo no cambia", () => {
  const p = placeholderize("Hola Acme Store", V);
  assert.equal(p.text, "Hola {{OPERATOR_NAME}}");
});

test("el conflicto restituye {{TOOLS_LIST}} en importPreview cuando recibe el bloque", () => {
  const rows = [toolRow("cotizar", "Calcula una cotización")];
  const composedWith = (op: string) => composeSystem(op, V, rows);
  const c = detectPromptConflict({
    liveSystem: composedWith("Sos de {{OPERATOR_NAME}}. {{TOOLS_LIST}} Editado afuera."),
    liveVersion: 2,
    syncedHash: undefined,
    registeredVersion: null,
    composedSystem: composedWith("Otro prompt"),
    placeholderValues: V,
    toolsList: renderToolsList(rows),
  });
  assert.ok(c?.importPreview);
  assert.equal(c.importPreview.text, "Sos de {{OPERATOR_NAME}}. {{TOOLS_LIST}} Editado afuera.");
  assert.equal(c.importPreview.changed, true);
});

// ─── B-S2: marcador del scaffold con SYSTEM_PROMPT vacío ───

const SCAFFOLD = "---\n\n## Flujo obligatorio antes de redactar\n\nPasos fijos del sistema.\n";
const compose = (operator: string) => `${operator.trim()}\n\n${SCAFFOLD}`;

test("extractOperatorPrompt tolera el scaffold AL INICIO (SYSTEM_PROMPT vacío): operador = \"\"", () => {
  assert.equal(extractOperatorPrompt(SCAFFOLD), "");
  assert.equal(extractOperatorPrompt(`\n\n${SCAFFOLD}`), "");
  assert.equal(extractOperatorPrompt(compose("")), "");
  assert.equal(extractScaffold(compose("")), SCAFFOLD.trim());
  // Un «---» suelto al inicio que no es el encabezado del scaffold NO cuenta.
  assert.equal(extractOperatorPrompt("---\n\nOtra cosa"), null);
});

test("composeSystem real con SYSTEM_PROMPT vacío se puede separar", () => {
  const sys = composeSystem("", V);
  assert.equal(extractOperatorPrompt(sys), "");
  assert.ok(extractScaffold(sys)?.startsWith("---"));
});

test("DB con SYSTEM_PROMPT vacío y vivo con un operador escrito afuera: conflicto separable e importable", () => {
  const c = detectPromptConflict({
    liveSystem: compose("Prompt escrito afuera"),
    liveVersion: 3,
    syncedHash: undefined,
    registeredVersion: null,
    composedSystem: compose(""),
  });
  assert.ok(c);
  assert.equal(c.scope, "operator");
  assert.equal(c.importPreview?.text, "Prompt escrito afuera");
});

test("vivo con operador vacío y DB con operador: se puede importar el vacío", () => {
  const c = detectPromptConflict({
    liveSystem: compose(""),
    liveVersion: 3,
    syncedHash: undefined,
    registeredVersion: null,
    composedSystem: compose("Algo en la DB"),
  });
  assert.ok(c);
  assert.equal(c.scope, "operator");
  assert.equal(c.importPreview?.text, "");
});
