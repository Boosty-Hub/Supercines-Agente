// _shared/crm-nota.ts
// Armado PURO de la nota interna que `transferir_asesor` deja en Kommo — sin
// I/O. Separada de `runCrmTool` para poder fijar el formato con un test sin
// levantar la Edge Function ni mockear fetch.
//
// La nota es la ÚNICA pieza que sobrevive si el movimiento de etapa falla o si
// no hay ninguna etapa de atención humana configurada (ver runCrmTool /
// transferir_asesor en generate-response/index.ts): por eso lleva el prefijo
// que la hace reconocible entre las notas manuales de un asesor, y por eso se
// recorta — un motivo de diez mil caracteres (el mensaje del lead pegado
// entero) es justo el tipo de cosa que Kommo rechaza.
//
// SIN EMOJI a propósito: `addLeadNote` pasa el texto por
// `sanitizeKommoFieldValue` (misma defensa que los custom fields, ver
// kommo.ts) y un emoji astral desaparecería en silencio — un prefijo que el
// código promete y el texto guardado no tiene es peor que no tener prefijo.
const MAX_NOTA_CHARS = 2000;

export function construirNotaTransferencia(motivo: string): string {
  const limpio = motivo.trim().slice(0, MAX_NOTA_CHARS);
  return `[Agente] Derivó esta conversación a un asesor humano.\n\nMotivo: ${limpio}`;
}
