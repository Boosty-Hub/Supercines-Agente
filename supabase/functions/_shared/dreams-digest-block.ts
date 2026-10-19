// _shared/dreams-digest-block.ts
// Bloque `aprendizajes_del_operador` del [CONTEXTO] (generate-response y follow-up-scan)
// y la regla de datos que comparten la generación de dreams y su consolidación.
//
// Por qué existe (KIA, oct-2026): el digest de dreams llega al agente con PRIORIDAD
// MÁXIMA. Dreams destila sus aprendizajes de lo que el AGENTE dijo en conversaciones
// reales, y el agente repetía desde julio un precio por versión («Soluto automático
// $25.500») que venía de una KB vieja ya retirada. Dreams lo «confirmó» por repetición
// («la información estándar manejada en todas las demás conversaciones»), lo fijó como
// regla y el agente siguió dándolo, ahora con prioridad sobre el catálogo: un error
// que se realimenta solo. Dos cortes, en el código y no en el prompt del operador:
//   1) al generar y al consolidar, una cifra respaldada solo por lo que dijo el agente
//      no se convierte en regla (LEARNINGS_DATA_RULE);
//   2) al inyectar el digest, el agente sabe que los aprendizajes son reglas de
//      conducta, no una fuente de datos (DREAMS_DIGEST_DATA_RULE).

/** Regla para el modelo de Dreams (generación de learnings y consolidación del digest). */
export const LEARNINGS_DATA_RULE =
  "Los aprendizajes NO son una fuente de datos. Nunca fijes como correcto un precio, monto, horario, función, versión, especificación o " +
  "condición comercial a partir de lo que dijo el AGENTE en las conversaciones, aunque lo repita en muchas: puede ser el " +
  "mismo error repetido. Una cifra solo puede figurar en un aprendizaje si la respalda una fuente oficial del operador " +
  "(su system prompt, la KB, la cartelera o un catálogo) o si la dio el propio lead; si el agente dio cifras distintas o sin respaldo " +
  "para lo mismo, el aprendizaje es «tomar ese dato solo de la fuente oficial», SIN escribir la cifra.";

/** Aclaración que acompaña al digest en el contexto del agente. */
export const DREAMS_DIGEST_DATA_RULE =
  "Son reglas de conducta, NO una fuente de datos: precios, montos, horarios, funciones, especificaciones y condiciones salen " +
  "SOLO de tus fuentes oficiales (tu system prompt, search_kb, tus herramientas —p. ej. la cartelera— y los bloques de datos de este contexto). Si un " +
  "aprendizaje trae una cifra o un dato que no figura en ellas, ignorá esa cifra o ese dato";

/** Bloque del [CONTEXTO] con el digest; "" si no hay digest. Termina en salto de línea. */
export function dreamsDigestBlock(digest: string | null | undefined): string {
  const d = (digest ?? "").trim();
  if (!d) return "";
  return `aprendizajes_del_operador (reglas del operador aprendidas de conversaciones reales — PRIORIDAD MÁXIMA sobre tu voz base; aplicalas SIEMPRE. ${DREAMS_DIGEST_DATA_RULE}):\n${d}\n`;
}
