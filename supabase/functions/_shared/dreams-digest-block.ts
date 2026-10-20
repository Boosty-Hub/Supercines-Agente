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

import { agentFacingFacts, removeDataShapeLines } from "./dreams-facts.ts";

/**
 * Regla para el modelo de Dreams (generación de learnings y consolidación del digest).
 * Oct-2026 (SuperCines): ya no basta con cifras — también se fijaban estados y causas
 * («Playa Mar cerrada por afectación sísmica»), correos, horarios, condiciones de promos.
 * Un aprendizaje describe CONDUCTA; los datos del negocio salen de las fuentes oficiales.
 * La red determinista que acompaña a esta regla está en dreams-facts.ts.
 */
export const LEARNINGS_DATA_RULE =
  "Los aprendizajes describen CONDUCTA (cómo responder, qué verificar, cuándo derivar), NUNCA datos del negocio: " +
  "NO son una fuente de datos. No escribas como hecho ningún precio, monto, función, versión, especificación, estado o causa " +
  "(p. ej. «la sede X está cerrada por …»), correo, teléfono, enlace, horario, fecha, requisito, disponibilidad, " +
  "política ni condición de una promoción a partir de lo que dijo el AGENTE en las conversaciones, aunque lo repita " +
  "en muchas: puede ser el mismo error repetido. Esos datos salen SOLO de las fuentes oficiales del operador (su " +
  "system prompt, la KB, la cartelera, las situaciones, las promociones y las herramientas). Si el agente dio un dato distinto o sin " +
  "respaldo, el aprendizaje es «tomar ese dato solo de la fuente oficial», SIN escribir el dato.";

/** Aclaración que acompaña al digest en el contexto del agente. */
export const DREAMS_DIGEST_DATA_RULE =
  "Son reglas de conducta, NO una fuente de datos: precios, montos, funciones, versiones, especificaciones, condiciones y " +
  "promociones, horarios, fechas, correos, teléfonos, enlaces, requisitos, disponibilidad y el estado de sedes o " +
  "servicios salen SOLO de tus fuentes oficiales (tu system prompt, search_kb, tus herramientas —p. ej. la cartelera— y " +
  "los bloques de datos de este contexto). Si un aprendizaje trae una cifra o un dato que no figura en ellas, ignora esa cifra o ese dato";

/**
 * Bloque del [CONTEXTO] con el digest; "" si no hay digest. Termina en salto de línea.
 * Reescribe el marcador de dato neutralizado («[dato: …]») con una frase natural
 * (agentFacingFacts): un digest guardado antes de ese corte no espera al próximo rebuild.
 * Defensa en profundidad: una viñeta con un correo, enlace, teléfono o monto no llega al
 * agente (removeDataShapeLines; la consolidación ya las saca, pero un digest guardado antes o
 * escrito por otro camino no espera al próximo rebuild). Se quita en silencio, solo se loguea
 * la cuenta (nunca el contenido).
 */
export function dreamsDigestBlock(digest: string | null | undefined): string {
  const shaped = removeDataShapeLines(agentFacingFacts((digest ?? "").trim()));
  if (shaped.removed.length > 0) {
    console.warn(`dreams digest: ${shaped.removed.length} viñetas con dato de alto riesgo omitidas al inyectar`);
  }
  const d = shaped.text.trim();
  if (!d) return "";
  return `aprendizajes_del_operador (reglas del operador aprendidas de conversaciones reales — PRIORIDAD MÁXIMA sobre tu voz base; aplícalas SIEMPRE. ${DREAMS_DIGEST_DATA_RULE}):\n${d}\n`;
}
