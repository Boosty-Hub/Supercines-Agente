// _shared/text.ts
// Normalización de texto para comparaciones "flojas" (match de términos,
// resolución de campos/enums de Kommo por nombre).
//
// El operador escribe "La Cascada" en el dashboard y el lead escribe "la
// cascada" o "LA CASCADA"; el campo en Kommo se llama "Tipo de Evento" y el
// enum "Cumpleaños (Súper)". Comparar eso con === es garantía de que un día
// falla por un acento. Normalizamos ambos lados antes de comparar.

/**
 * Minúsculas, sin acentos/diacríticos, sin espacios de más.
 * NFD separa la letra de su tilde y el rango U+0300-U+036F borra la tilde.
 */
export function normalizeLoose(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿Aparece `term` dentro de `text` como palabra/frase y no como fragmento?
 *
 * Un `includes` pelado convierte "coro" (ciudad) en un match dentro de
 * "recorodar" y rutea mal el lead. Exigimos que el término esté delimitado por
 * algo que no sea letra ni dígito. Ambos lados llegan ya normalizados.
 */
export function containsTerm(normalizedText: string, normalizedTerm: string): boolean {
  if (!normalizedTerm) return false;
  let from = 0;
  for (;;) {
    const at = normalizedText.indexOf(normalizedTerm, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : normalizedText[at - 1];
    const afterIdx = at + normalizedTerm.length;
    const after = afterIdx >= normalizedText.length ? "" : normalizedText[afterIdx];
    const isWordChar = (c: string) => c !== "" && /[\p{L}\p{N}]/u.test(c);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}
