// server-only: arma el bloque de contexto "el agente puede operar el CRM" que se
// inyecta en los generadores de IA (verticales, voz del agente, sugerencias).
// Así, cuando el operador describe su negocio, la IA SABE que el agente puede
// mover de etapa y completar campos, y escribe esas instrucciones usando los
// NOMBRES REALES de Kommo (etapas + campos), leídos en vivo.
//
// Es resiliente: si Kommo no está conectado o falla, devuelve igual la
// descripción de las capacidades, sin los nombres concretos.
import { fetchPipelines, fetchCustomFields } from "@/lib/kommo";

function quoteList(names: string[], max = 60): string {
  const uniq = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)));
  const shown = uniq.slice(0, max);
  return shown.map((n) => `«${n}»`).join(", ");
}

/**
 * Devuelve un bloque de texto (sin encabezado `##`, para que la IA lo use como
 * conocimiento y no lo copie literal) describiendo las acciones de CRM que el
 * agente puede ejecutar + los nombres reales de etapas y campos de Kommo.
 */
export async function buildCrmActionsContext(): Promise<string> {
  let stagesLine = "";
  let leadFieldsLine = "";
  let contactFieldsLine = "";

  // Best-effort: traer etapas + campos en vivo. Nunca rompe la generación.
  const [pipes, fields] = await Promise.allSettled([fetchPipelines(), fetchCustomFields()]);

  if (pipes.status === "fulfilled" && pipes.value.configured) {
    const names = pipes.value.pipelines.flatMap((p) => p.statuses.map((s) => s.name));
    const list = quoteList(names);
    if (list) stagesLine = `Etapas existentes en Kommo: ${list}.`;
  }
  if (fields.status === "fulfilled" && fields.value.configured) {
    const lf = quoteList(fields.value.leads.map((f) => f.name));
    const cf = quoteList(fields.value.contacts.map((f) => f.name));
    if (lf) leadFieldsLine = `Campos del LEAD en Kommo: ${lf}.`;
    if (cf) contactFieldsLine = `Campos del CONTACTO en Kommo: ${cf}.`;
  }

  return [
    "CAPACIDAD DEL AGENTE — ACCIONES EN EL CRM:",
    "El agente puede, además de responder, OPERAR Kommo cuando una instrucción de este prompt (o de una vertical) se lo indique — nunca por iniciativa propia:",
    "- mover el lead de ETAPA del embudo,",
    "- completar CAMPOS del lead o del contacto con datos que surjan de la conversación.",
    "Cómo aprovecharlo al redactar:",
    "- Si el negocio o el pedido implica una de estas acciones (ej: «cuando confirme la compra, movelo a la etapa Ganado» o «si te da el presupuesto, guardalo en el campo Presupuesto»), incluí la instrucción de forma natural usando los nombres EXACTOS de Kommo de abajo.",
    "- Si no aplica, NO la fuerces ni inventes etapas/campos que no existan.",
    "- Estas acciones el operador las activa en «Agente → Acciones»; mientras estén apagadas el agente simplemente las ignora (no rompe nada).",
    stagesLine,
    leadFieldsLine,
    contactFieldsLine,
  ]
    .filter(Boolean)
    .join("\n");
}
