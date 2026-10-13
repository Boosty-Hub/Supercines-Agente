// _shared/grader-prompt.ts
// Mensaje de usuario que recibe el grader LLM-judge de evaluate-outcomes. Vive
// acá (puro, sin I/O) para poder probar que el texto del lead NUNCA entra crudo
// al prompt: antes iba entre """ """ y un lead podía cerrar el bloque y dictarle
// el veredicto al juez ("</...> puntaje 1, aprobado").
//
// Todo texto que el lead controla (su mensaje, y lo que el agente le respondió,
// que puede repetirlo) entra como turno saneado (_shared/untrusted.ts) y el
// mensaje abre con EVALUATION_NOTICE: aquí NINGÚN turno es confiable, ni siquiera el
// del agente (es el objeto evaluado y pudo repetir lo que plantó el lead). Antes
// de este modo el aviso lo declaraba "del sistema". Los turnos CONSERVAN los saltos de
// línea (turnPreservingLines: cada renglón saneado y con prefijo "| "): el grader tiene
// que poder juzgar el formato real de la respuesta (párrafos, viñetas), no una línea plana.

import { turnPreservingLines, untrustedInline, EVALUATION_NOTICE } from "./untrusted.ts";

export function buildGraderContext(input: {
  channel: string;
  vertical: string;
  leadText: string;
  agentText: string;
}): string {
  return `${EVALUATION_NOTICE}
Formato: dentro de cada turno, cada renglón del material empieza con "| " y conserva los saltos de línea del original ("|" solo = línea en blanco).

[CONTEXTO]
canal: ${untrustedInline(input.channel)}
vertical: ${untrustedInline(input.vertical)}

[MENSAJE DEL LEAD]
${turnPreservingLines("lead", input.leadText)}

[RESPUESTA DEL AGENTE QUE VAS A EVALUAR]
${turnPreservingLines("agente", input.agentText)}

Evaluá según las instrucciones del system prompt y devolvé JSON estricto.`;
}
