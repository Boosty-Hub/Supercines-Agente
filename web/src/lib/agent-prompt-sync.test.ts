// Tests de la detección de conflicto del system prompt (puro).
// Correr con: cd web && node --test src/lib/agent-prompt-sync.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  conflictMessage,
  detectPromptConflict,
  extractOperatorPrompt,
  hashPrompt,
  lineDiff,
} from "./agent-prompt-sync.ts";

const SCAFFOLD = "---\n\n## Flujo obligatorio antes de redactar\n\nPasos fijos del sistema.\n";
const compose = (operator: string, scaffold = SCAFFOLD) => `${operator.trim()}\n\n${scaffold}`;

test("SIN cambios externos: el vivo es lo último enviado → no hay conflicto", () => {
  const sent = compose("Sos el asistente de Acme.\nTono cálido.");
  const c = detectPromptConflict({
    liveSystem: sent,
    liveVersion: 7,
    syncedHash: hashPrompt(sent),
    registeredVersion: 7,
    // el operador editó su prompt en el dashboard: eso es lo que se enviaría ahora
    composedSystem: compose("Sos el asistente de Acme.\nTono cálido y breve."),
  });
  assert.equal(c, null);
});

test("el hash ignora fin de línea y espacios en los extremos (Anthropic puede normalizarlos)", () => {
  const sent = compose("Hola\nmundo");
  assert.equal(hashPrompt(sent), hashPrompt(`  ${sent.replace(/\n/g, "\r\n")}\n\n`));
});

test("CON cambio externo: el prompt vivo difiere de lo último enviado → conflicto con diff", () => {
  const sent = compose("Sos el asistente de Acme.\nTono cálido.");
  const editedOutside = compose("Sos el asistente de Acme.\nTono formal.\nNunca des descuentos.");
  const c = detectPromptConflict({
    liveSystem: editedOutside,
    liveVersion: 8,
    syncedHash: hashPrompt(sent),
    registeredVersion: 7,
    composedSystem: compose("Sos el asistente de Acme.\nTono cálido y breve."),
  });
  assert.ok(c);
  assert.equal(c.kind, "prompt_changed");
  assert.equal(c.live.operatorPrompt, "Sos el asistente de Acme.\nTono formal.\nNunca des descuentos.");
  assert.equal(c.db.operatorPrompt, "Sos el asistente de Acme.\nTono cálido y breve.");
  const del = c.diff.filter((l) => l.type === "del").map((l) => l.text);
  const add = c.diff.filter((l) => l.type === "add").map((l) => l.text);
  assert.deepEqual(del, ["Tono formal.", "Nunca des descuentos."]);
  assert.deepEqual(add, ["Tono cálido y breve."]);
  assert.match(conflictMessage(c), /modificado fuera del dashboard/);
});

test("PRIMERA vez (sin hash registrado): si difieren es conflicto", () => {
  const c = detectPromptConflict({
    liveSystem: compose("Prompt viejo en Anthropic"),
    liveVersion: 3,
    syncedHash: undefined,
    registeredVersion: null,
    composedSystem: compose("Prompt de la DB"),
  });
  assert.ok(c);
  assert.equal(c.kind, "first_sync_differs");
});

test("PRIMERA vez: si lo vivo ya coincide con lo que se enviaría, se adopta sin preguntar", () => {
  const same = compose("Igual en los dos lados");
  assert.equal(
    detectPromptConflict({ liveSystem: same, liveVersion: 1, syncedHash: null, registeredVersion: null, composedSystem: same }),
    null,
  );
});

test("versión viva MAYOR que la registrada → conflicto aunque el texto coincida (alguien subió una versión)", () => {
  const sent = compose("Mismo texto");
  const c = detectPromptConflict({
    liveSystem: sent,
    liveVersion: 9,
    syncedHash: hashPrompt(sent),
    registeredVersion: 7,
    composedSystem: sent,
  });
  assert.ok(c);
  assert.equal(c.kind, "version_ahead");
  assert.equal(c.diff.every((l) => l.type === "same"), true);
});

test("agente sin system vivo: nada que sobrescribir, no hay conflicto", () => {
  assert.equal(
    detectPromptConflict({ liveSystem: "", liveVersion: 1, syncedHash: null, registeredVersion: null, composedSystem: compose("X") }),
    null,
  );
});

test("extractOperatorPrompt separa el prompt del operador del scaffold, y devuelve null si el scaffold no está", () => {
  assert.equal(extractOperatorPrompt(compose("  Hola  ")), "Hola");
  assert.equal(extractOperatorPrompt("un system sin el scaffold del sistema"), null);
});

// ─── W3(b): primera sincronización (clientes existentes sin AGENT_PROMPT_SYNCED_HASH) ───

const OLD_SCAFFOLD = "---\n\n## Flujo obligatorio antes de redactar\n\nPasos VIEJOS del sistema.\n";
const NEW_SCAFFOLD = "---\n\n## Flujo obligatorio antes de redactar\n\nPasos NUEVOS del sistema.\nAcciones CRM.\n";

test("PRIMERA vez, mismo prompt de operador con scaffold distinto: se adopta, NO hay conflicto", () => {
  const c = detectPromptConflict({
    liveSystem: compose("Sos Acme.\nTono cálido.", OLD_SCAFFOLD),
    liveVersion: 4,
    syncedHash: undefined,
    registeredVersion: 4,
    composedSystem: compose("Sos Acme.\nTono cálido.", NEW_SCAFFOLD),
  });
  assert.equal(c, null);
});

test("PRIMERA vez, operador distinto: el diff es SOLO del operador y el scaffold va aparte", () => {
  const c = detectPromptConflict({
    liveSystem: compose("Sos Acme.\nTono formal.", OLD_SCAFFOLD),
    liveVersion: 4,
    syncedHash: undefined,
    registeredVersion: null,
    composedSystem: compose("Sos Acme.\nTono cálido.", NEW_SCAFFOLD),
  });
  assert.ok(c);
  assert.equal(c.kind, "first_sync_differs");
  assert.equal(c.scope, "both");
  assert.deepEqual(c.diff.filter((l) => l.type === "del").map((l) => l.text), ["Tono formal."]);
  assert.deepEqual(c.diff.filter((l) => l.type === "add").map((l) => l.text), ["Tono cálido."]);
  assert.ok(c.diff.every((l) => !l.text.includes("Pasos")));
  assert.ok(c.scaffoldDiff && c.scaffoldDiff.some((l) => l.text.includes("Pasos VIEJOS")));
  assert.match(c.message, /prompt del OPERADOR/);
  assert.match(c.message, /Difieren el prompt del operador y las instrucciones del sistema/);
});

test("PRIMERA vez, solo operador distinto (scaffold igual): scope=operator, sin scaffoldDiff", () => {
  const c = detectPromptConflict({
    liveSystem: compose("A"),
    liveVersion: 1,
    syncedHash: null,
    registeredVersion: null,
    composedSystem: compose("B"),
  });
  assert.ok(c);
  assert.equal(c.scope, "operator");
  assert.equal(c.scaffoldDiff, null);
  assert.match(c.message, /Difiere el prompt del operador\./);
});

test("PRIMERA vez con system vivo sin el scaffold esperado: scope=unknown con el system completo", () => {
  const c = detectPromptConflict({
    liveSystem: "Un system escrito a mano, sin estructura del sistema",
    liveVersion: 2,
    syncedHash: undefined,
    registeredVersion: null,
    composedSystem: compose("Sos Acme."),
  });
  assert.ok(c);
  assert.equal(c.scope, "unknown");
  assert.equal(c.importPreview, null);
  assert.match(c.message, /no conserva la estructura esperada/);
});

test("CON hash, operador idéntico pero scaffold editado por fuera: scope=scaffold y lo dice", () => {
  const sent = compose("Sos Acme.", OLD_SCAFFOLD);
  const edited = compose("Sos Acme.", OLD_SCAFFOLD.replace("VIEJOS", "TOCADOS"));
  const c = detectPromptConflict({
    liveSystem: edited,
    liveVersion: 6,
    syncedHash: hashPrompt(sent),
    registeredVersion: 5,
    composedSystem: compose("Sos Acme.", NEW_SCAFFOLD),
  });
  assert.ok(c);
  assert.equal(c.kind, "prompt_changed");
  assert.equal(c.scope, "scaffold");
  assert.equal(c.diff.every((l) => l.type === "same"), true);
  assert.ok(c.scaffoldDiff && c.scaffoldDiff.some((l) => l.type === "del" && l.text.includes("TOCADOS")));
  assert.match(c.message, /operador es idéntico/);
});

test("CON hash viejo pero lo vivo ya es exactamente lo que se enviaría: sin conflicto (no se pierde nada)", () => {
  const same = compose("Sos Acme.", NEW_SCAFFOLD);
  assert.equal(
    detectPromptConflict({
      liveSystem: same,
      liveVersion: 9,
      syncedHash: hashPrompt(compose("otro")),
      registeredVersion: 8,
      composedSystem: same,
    }),
    null,
  );
});

// ─── W6: la vista previa de import_live re-placeholderiza ───

test("el conflicto trae importPreview con los placeholders restituidos", () => {
  const values = { operatorName: "Acme Store", masterStoreName: "acme-master", leadsStoreName: "acme-leads" };
  const live = compose("Sos de Acme Store. Leé /mnt/memory/acme-master/voice/ y /mnt/memory/acme-leads/x.md", OLD_SCAFFOLD);
  const c = detectPromptConflict({
    liveSystem: live,
    liveVersion: 2,
    syncedHash: undefined,
    registeredVersion: null,
    composedSystem: compose("distinto"),
    placeholderValues: values,
  });
  assert.ok(c?.importPreview);
  assert.equal(c.importPreview.text, "Sos de {{OPERATOR_NAME}}. Leé {{MASTER_PATH}}/voice/ y {{LEADS_PATH}}/x.md");
  assert.equal(c.importPreview.changed, true);
  assert.deepEqual(c.importPreview.ambiguous, []);
});

test("lineDiff: agregados, borrados y líneas iguales en orden", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), [
    { type: "same", text: "a" },
    { type: "del", text: "b" },
    { type: "add", text: "x" },
    { type: "same", text: "c" },
  ]);
});
