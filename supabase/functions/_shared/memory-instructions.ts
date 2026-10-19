// _shared/memory-instructions.ts
// Texto de `resources[].instructions` de los Memory Stores montados en cada
// sesión CMA (generate-response y follow-up-scan). Una sola fuente: el texto de
// ahí es lo que el agente cree que debe hacer con el filesystem de memoria, y
// debe ser coherente con el CORE_SCAFFOLD (web/src/lib/agent-prompt.ts) y con
// lo que el [CONTEXTO] ya trae.
//
// Por qué NO se le pide leer conversation.md ni /dreams/:
//  - El historial de la conversación viaja determinístico en el [CONTEXTO]
//    ([HISTORIAL], fetchLeadHistory desde la DB). Leerlo y reescribirlo desde el
//    store era el mayor costo de tokens por respuesta y un tool call que el
//    modelo podía omitir.
//  - Los aprendizajes (dreams) viajan consolidados en el bloque
//    `aprendizajes_del_operador` (runtime_config.DREAMS_DIGEST). Listar y leer
//    /dreams/ en cada sesión (llegó a haber 231 archivos activos) costaba
//    listado + lecturas + turnos extra POR RESPUESTA.
// learnings.md se mantiene: datos duraderos del lead que no están en la
// conversación (y que alimentan a Dreams).

export const MASTER_STORE_INSTRUCTIONS =
  "Memoria del operador (solo lectura). /voice/: voz, reglas y ejemplos del operador; si hace falta, lista con glob y lee solo lo que aplica al mensaje (grep por palabras clave), no todo. " +
  "/kb/: conocimiento destilado; para datos factuales usa la tool search_kb en lugar de leer archivos. " +
  "/dreams/: NO lo leas; los aprendizajes consolidados ya vienen en el [CONTEXTO] (bloque aprendizajes_del_operador).";

export function leadsStoreInstructions(leadId: string): string {
  return (
    `Memoria por lead. El lead actual es ${leadId}. Si existe, lee /${leadId}/learnings.md (datos duraderos de este lead). ` +
    "El historial de la conversación ya viene en el mensaje de la sesión (historial reciente, tanto al responder como en seguimientos); no lo busques en este store ni lo reescribas. " +
    `Solo si aprendiste algo DURADERO sobre este lead en este turno (preferencia, dato de contacto verificado, reclamo abierto, estado en el funnel), agrégalo a /${leadId}/learnings.md. ` +
    "Si no hay nada duradero que registrar, no escribas nada."
  );
}
