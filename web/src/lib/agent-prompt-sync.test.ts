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

test("lineDiff: agregados, borrados y líneas iguales en orden", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), [
    { type: "same", text: "a" },
    { type: "del", text: "b" },
    { type: "add", text: "x" },
    { type: "same", text: "c" },
  ]);
});
