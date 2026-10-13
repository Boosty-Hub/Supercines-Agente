// _shared/crm-nota.test.ts
// Deno tests para el armado puro de la nota interna de `transferir_asesor`.
//
// Correr con: deno test --allow-read supabase/functions/_shared/crm-nota.test.ts

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { construirNotaTransferencia } from "./crm-nota.ts";

Deno.test("construirNotaTransferencia: incluye el prefijo y el motivo completo", () => {
  const nota = construirNotaTransferencia("El lead pide hablar con una persona sobre su pedido.");
  assertStringIncludes(nota, "[Agente] Derivó esta conversación a un asesor humano.");
  assertStringIncludes(nota, "Motivo: El lead pide hablar con una persona sobre su pedido.");
});

Deno.test("construirNotaTransferencia: recorta espacios en los extremos del motivo", () => {
  const nota = construirNotaTransferencia("   pidió hablar con alguien   ");
  assertStringIncludes(nota, "Motivo: pidió hablar con alguien");
});

Deno.test("construirNotaTransferencia: nunca lleva un emoji astral (sanitizeKommoFieldValue lo pisaría)", () => {
  const nota = construirNotaTransferencia("motivo cualquiera");
  for (const ch of nota) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) assertEquals(cp <= 0xffff, true, `carácter astral inesperado: ${ch}`);
  }
});

Deno.test("construirNotaTransferencia: recorta motivos extremadamente largos (Kommo rechaza notas gigantes)", () => {
  const motivoLargo = "a".repeat(5000);
  const nota = construirNotaTransferencia(motivoLargo);
  assertEquals(nota.length <= 2000 + "[Agente] Derivó esta conversación a un asesor humano.\n\nMotivo: ".length, true);
});

Deno.test("construirNotaTransferencia: el recorte a 2000 no parte un emoji ni deja surrogates sueltos", () => {
  const casos = ["😊".repeat(1500), "👨‍👩‍👧‍👦".repeat(300), `${"a".repeat(1999)}😊`, `\uD83D${"b".repeat(50)}\uDE0A`];
  for (const motivo of casos) {
    const nota = construirNotaTransferencia(motivo);
    const motivoOut = nota.slice(nota.indexOf("Motivo: ") + 8);
    if (motivoOut.length > 2000) throw new Error("excede el máximo");
    if (!nota.isWellFormed()) throw new Error("surrogate suelto");
  }
});
