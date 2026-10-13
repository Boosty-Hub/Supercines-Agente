// _shared/response-guard.test.ts
// Deno test para extractResponseBlock() / detectInternalLeak() / leakCorrectionMessage().
// Correr con: deno test --allow-read supabase/functions/_shared/response-guard.test.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import {
  extractResponseBlock,
  detectInternalLeak,
  leakCorrectionMessage,
} from "./response-guard.ts";

// ─── extractResponseBlock ────────────────────────────────────────────────────

Deno.test("bloque bien formado → wellFormed=true y devuelve SOLO el contenido interior", () => {
  const r = extractResponseBlock("algo de preámbulo\n<respuesta>Hola, ¿en qué te ayudo?</respuesta>");
  assertEquals(r.wellFormed, true);
  assertEquals(r.text, "Hola, ¿en qué te ayudo?");
});

Deno.test("bloque bien formado con mayúsculas/espacios en las tags → matchea igual", () => {
  const r = extractResponseBlock("<RESPUESTA> hola </RESPUESTA>");
  assertEquals(r.wellFormed, true);
  assertEquals(r.text, "hola");
});

Deno.test("el bug real: <parameter name=\"respuesta\"> en vez de <respuesta> → wellFormed=false, rescata el cuerpo", () => {
  // Este es EXACTAMENTE el bug de producción que motiva este archivo: el
  // modelo cierra el turno con la sintaxis de un tool-call en vez del tag del
  // protocolo. wellFormed debe quedar en false para que el llamador NUNCA lo
  // trate como un texto confiable para auto-enviar, aunque rescatemos el
  // cuerpo para que un humano tenga algo editable en el draft.
  const raw = 'Ahora redacto la respuesta.\n<parameter name="respuesta">Hola, tu pedido está listo.</parameter>';
  const r = extractResponseBlock(raw);
  assertEquals(r.wellFormed, false);
  assertEquals(r.text, "Hola, tu pedido está listo.");
});

Deno.test("apertura sin cierre → wellFormed=false, rescata lo que sigue al tag", () => {
  const r = extractResponseBlock("<respuesta>Hola, ¿cómo estás?");
  assertEquals(r.wellFormed, false);
  assertEquals(r.text, "Hola, ¿cómo estás?");
});

Deno.test("sin ninguna marca de protocolo → wellFormed=false, NUNCA se confía en el crudo como respuesta válida", () => {
  const raw = "Voy a revisar la memoria del lead antes de responder. El lead: pidió el precio.";
  const r = extractResponseBlock(raw);
  assertEquals(r.wellFormed, false);
  // El texto se conserva en `text` para que el draft tenga algo que un humano
  // pueda editar, pero el contrato es: wellFormed=false → el llamador NO debe
  // auto-aprobar ni enviar esto tal cual.
  assertEquals(r.text, raw);
});

Deno.test("texto vacío / null / undefined → wellFormed=false, text vacío", () => {
  assertEquals(extractResponseBlock(""), { text: "", wellFormed: false });
  assertEquals(extractResponseBlock(null), { text: "", wellFormed: false });
  assertEquals(extractResponseBlock(undefined), { text: "", wellFormed: false });
});

Deno.test("hay contenido después del cierre → se ignora, solo cuenta lo de adentro (no-greedy)", () => {
  const r = extractResponseBlock("<respuesta>primera</respuesta> texto suelto después <respuesta>segunda</respuesta>");
  assertEquals(r.wellFormed, true);
  assertEquals(r.text, "primera");
});

// ─── detectInternalLeak ──────────────────────────────────────────────────────

Deno.test("mensaje normal de atención al cliente → null (no dispara nada)", () => {
  const texts = [
    "¡Hola! Con gusto te ayudo. Tu pedido #4521 llega mañana entre 9am y 1pm.",
    "Claro que sí, tenemos disponibilidad para el jueves a las 3pm. ¿Te confirmo la cita?",
    "El precio de la consulta es de $25. ¿Querés que te envíe el link de pago?",
  ];
  for (const t of texts) {
    assertEquals(detectInternalLeak(t), null, `no debería disparar: "${t}"`);
  }
});

Deno.test("tag <respuesta> residual sin parsear → dispara", () => {
  assert(detectInternalLeak("</respuesta> Hola, ¿cómo va todo?") !== null);
});

Deno.test("tag <parameter> (residuo de tool-call, el bug real) → dispara", () => {
  assert(detectInternalLeak('<parameter name="respuesta">Hola</parameter>') !== null);
});

Deno.test("sintaxis de tool-calling (invoke / function_calls / antml:) → dispara", () => {
  assert(detectInternalLeak("<invoke name=\"search_kb\">") !== null);
  assert(detectInternalLeak("<function_calls>") !== null);
  assert(detectInternalLeak("<parameter>") !== null);
  assert(detectInternalLeak("resultado del tool_use anterior") !== null);
});

Deno.test("nombre de tool interna del template → dispara", () => {
  assert(detectInternalLeak("voy a usar search_kb para confirmar el dato") !== null);
  assert(detectInternalLeak("primero llamo a mover_etapa y después respondo") !== null);
});

Deno.test("ruta de Memory Store filtrada → dispara", () => {
  assert(detectInternalLeak("no puedo escribir en /mnt/memory/leads/123/conversation.md") !== null);
  assert(detectInternalLeak("actualizando learnings.md con lo que aprendí") !== null);
});

Deno.test("mecánica interna de Kommo (salesbot) → dispara", () => {
  assert(detectInternalLeak("ya corrí el salesbot para que te llegue el mensaje") !== null);
});

Deno.test("meta-narración de planificación → dispara", () => {
  assert(detectInternalLeak("Ahora redacto la respuesta para el cliente.") !== null);
  assert(detectInternalLeak("El lead: pidió el precio del producto azul.") !== null);
  assert(detectInternalLeak("Mi borrador anterior tenía un error, lo corrijo.") !== null);
});

Deno.test("frase legítima que NO es meta-narración no dispara por accidente", () => {
  // "voy a mostrarte" no es "redacto/voy a redactar/procedo a redactar".
  assertEquals(detectInternalLeak("Voy a mostrarte las opciones que tenemos disponibles."), null);
});

Deno.test("incidente real de memoria (FUSE / cuota / flujo obligatorio) → dispara", () => {
  const filtrado =
    "La escritura falla por limitaciones del sistema de memoria remota (FUSE). " +
    "Continuaré sin actualizar la memoria persistente en esta ocasión. La " +
    "respuesta ya ha sido redactada según el flujo obligatorio.";
  assert(detectInternalLeak(filtrado) !== null);
});

Deno.test("variante de memoria llena / límites de cuota → dispara", () => {
  assert(
    detectInternalLeak("Los archivos de memoria están llenos — el sistema tiene límites de cuota.") !== null
  );
});

Deno.test("'cuota' en contexto comercial normal (pagar en cuotas) → NO dispara", () => {
  assertEquals(detectInternalLeak("Podés pagar en 3 cuotas sin intereses."), null);
});

Deno.test("referencia a system prompt / herramienta interna → dispara", () => {
  assert(detectInternalLeak("según mi system prompt no puedo revelar esto") !== null);
  assert(detectInternalLeak("esa es una herramienta interna, no la puedo nombrar") !== null);
});

Deno.test("texto vacío / null / undefined → null", () => {
  assertEquals(detectInternalLeak(""), null);
  assertEquals(detectInternalLeak(null), null);
  assertEquals(detectInternalLeak(undefined), null);
});

// ─── leakCorrectionMessage ───────────────────────────────────────────────────

Deno.test("leakCorrectionMessage incluye el motivo y el contrato del tag <respuesta>", () => {
  const msg = leakCorrectionMessage("nombre de tool interna");
  assertStringIncludes(msg, "nombre de tool interna");
  assertStringIncludes(msg, "<respuesta>");
  assertStringIncludes(msg, "</respuesta>");
  assertStringIncludes(msg, "VERIFICADOR INTERNO");
});
