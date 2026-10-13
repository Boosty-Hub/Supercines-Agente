// _shared/dreams-digest-cap.test.ts
// Deno test para enforceDigestWordCap(). Correr con:
// deno test supabase/functions/_shared/dreams-digest-cap.test.ts

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { enforceDigestWordCap } from "./dreams-digest-cap.ts";

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

Deno.test("texto por debajo del tope vuelve intacto", () => {
  const text = "## Errores a no repetir\n- No pedir OTP nunca.";
  assertEquals(enforceDigestWordCap(text, 900), text);
});

Deno.test("texto exactamente en el tope vuelve intacto", () => {
  const text = Array.from({ length: 10 }, (_, i) => `palabra${i}`).join(" ");
  assertEquals(words(text), 10);
  assertEquals(enforceDigestWordCap(text, 10), text);
});

Deno.test("texto por encima del tope se recorta al límite de palabras", () => {
  const text = Array.from({ length: 20 }, (_, i) => `palabra${i}`).join("\n");
  const out = enforceDigestWordCap(text, 10);
  assert(words(out) <= 10, `esperaba <= 10 palabras, dio ${words(out)}`);
});

Deno.test("nunca corta a mitad de una línea/viñeta — cada línea sobrevive completa o no sobrevive", () => {
  const lines = [
    "## Errores a no repetir",
    "- Nunca pedir clave, OTP ni PIN por chat.",
    "- El precio siempre lo calcula el servidor.",
    "- Una póliza pendiente de pago no está activa.",
    "## Advertencias y gaps",
    "- Verificar documentos antes de renovar.",
  ];
  const text = lines.join("\n");
  // Tope elegido para forzar un corte a mitad del contenido (deja afuera la
  // última viñeta y la segunda sección), sin degenerar a "no entra nada".
  const out = enforceDigestWordCap(text, 25);
  const outLines = out.split("\n");
  for (const line of outLines) {
    assert(
      lines.includes(line),
      `la línea de salida "${line}" no es una línea completa del original`,
    );
  }
});

Deno.test("conserva encabezados de sección mientras haya contenido debajo", () => {
  const text = [
    "## Errores a no repetir",
    "- Error uno que ocupa varias palabras para sumar al conteo total.",
    "- Error dos que también suma bastantes palabras al total general.",
    "## Advertencias y gaps",
    "- Advertencia que no debería entrar porque el tope ya se llenó antes.",
  ].join("\n");
  const out = enforceDigestWordCap(text, 16);
  assert(out.startsWith("## Errores a no repetir"), "debe conservar el encabezado inicial");
});

Deno.test("quita encabezados que quedan colgando al final sin contenido debajo", () => {
  const bulletLine = Array.from({ length: 4 }, (_, i) => `palabra${i}`).join(" ");
  const headingLine = "## Sección vacía que no debería sobrevivir sola al final del corte";
  const text = [bulletLine, headingLine].join("\n");
  // Tope justo para que entre la primera línea pero no deje lugar a más
  // contenido real bajo el encabezado siguiente.
  const out = enforceDigestWordCap(text, 10);
  assertEquals(out, bulletLine, "un encabezado sin contenido debajo no debe quedar colgando al final");
});

Deno.test("garantía anti-pérdida-total: una única viñeta más larga que el tope sobrevive igual", () => {
  // Sin esta garantía, un digest cuya primera viñeta ya excede el tope se
  // borraría ENTERO y el operador perdería en silencio todos sus
  // aprendizajes acumulados — un digest pasado de tope es un costo
  // (cache-write de más), pero un digest vacío es pérdida de datos.
  const bullet = Array.from({ length: 20 }, (_, i) => `palabra${i}`).join(" ");
  assertEquals(enforceDigestWordCap(bullet, 5), bullet);
});

Deno.test("texto vacío vuelve vacío", () => {
  assertEquals(enforceDigestWordCap("", 900), "");
});

Deno.test("caso real: ~1290 palabras se recortan a <= 900", () => {
  const bullet = "Aprendizaje repetido sobre cómo tratar a un asegurado que llama por su póliza vencida hace poco.";
  const bulletWords = words(bullet);
  const bulletsNeeded = Math.ceil(1290 / bulletWords);
  const text = [
    "## Errores a no repetir",
    ...Array.from({ length: bulletsNeeded }, () => `- ${bullet}`),
  ].join("\n");
  assert(words(text) >= 1290, "el texto de prueba debe simular el exceso medido en producción");
  const out = enforceDigestWordCap(text, 900);
  assert(words(out) <= 900, `esperaba <= 900 palabras, dio ${words(out)}`);
});
