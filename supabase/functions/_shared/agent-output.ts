// Salida de la sesión CMA de generate-response: qué texto cuenta y qué decidió el agente.
//
// Por qué existe (bug real, SuperCines oct-2026: ~2–3 % de los drafts en `failed` con
// «agent devolvió respuesta vacía»): cuando el system prompt o los aprendizajes del
// operador dicen «si el lead manda solo emojis / una reacción / spam, NO respondas», el
// agente obedece y cierra con `<respuesta>\n</respuesta>` (o con un análisis «no
// respondo» sin bloque). El pipeline no tenía forma de expresar «no responder a
// propósito»: lo trataba como una FALLA (draft `failed` + alerta `draft_failed` por
// webhook), sin session_id para diagnosticar y sin registrar el consumo de la sesión.
//
// El protocolo ahora tiene dos salidas explícitas:
//   <respuesta>texto para el lead</respuesta>      → se responde
//   <sin_respuesta>motivo breve</sin_respuesta>    → no se responde, a propósito
// Un bloque vacío o ningún texto NO es una decisión: se le pide al agente, en la misma
// sesión, que elija una de las dos. Si aun así no decide, recién ahí es una falla.

import { extractResponseBlock } from "./response-guard.ts";

const NO_REPLY_RE = /<\s*sin_respuesta\s*>([\s\S]*?)<\s*\/\s*sin_respuesta\s*>|<\s*sin_respuesta\s*\/\s*>/i;
const HAS_PROTOCOL_TAG_RE = /<\s*\/?\s*(?:respuesta|sin_respuesta)\b/i;

/** Tope del motivo que se guarda (es texto del modelo: solo para el panel y los logs). */
export const NO_REPLY_REASON_MAX = 300;

export type AgentDecision =
  /** Hay texto para el lead. `wellFormed=false` ⇒ nunca auto-enviar (lo decide el guard). */
  | { kind: "reply"; text: string; wellFormed: boolean; ambiguous: boolean }
  /** El agente decidió explícitamente no responder. */
  | { kind: "no_reply"; reason: string }
  /** Ni texto ni decisión: bloque vacío, sin mensajes, o solo tool_use/thinking. */
  | { kind: "empty" };

function cleanReason(raw: string | undefined): string {
  const r = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!r) return "sin motivo indicado";
  return r.length > NO_REPLY_REASON_MAX ? `${r.slice(0, NO_REPLY_REASON_MAX - 1)}…` : r;
}

/**
 * Decide qué hizo el agente a partir del texto de su mensaje final.
 * - `<sin_respuesta>` sin un `<respuesta>` con contenido ⇒ no_reply.
 * - `<respuesta>` con contenido ⇒ reply (si además trae `<sin_respuesta>` es ambiguo:
 *   `wellFormed=false`, se reprocesa y, si persiste, va a revisión humana).
 * - Nada de lo anterior con texto ⇒ reply malformado (lo maneja el verificador de fuga).
 * - Vacío ⇒ empty.
 */
export function decideAgentOutput(raw: string | null | undefined): AgentDecision {
  const s = (raw ?? "").trim();
  const noReply = s.match(NO_REPLY_RE);
  const extracted = extractResponseBlock(s.replace(NO_REPLY_RE, "").trim());
  // Sin ninguna marca, extractResponseBlock devuelve el crudo como texto (malformado);
  // si lo único que había era el <sin_respuesta>, ese crudo es el razonamiento previo.
  const hasReplyBlock = /<\s*respuesta\s*>/i.test(s) || /name\s*=\s*"respuesta"/i.test(s);

  if (noReply) {
    if (hasReplyBlock && extracted.text) {
      return { kind: "reply", text: extracted.text, wellFormed: false, ambiguous: true };
    }
    return { kind: "no_reply", reason: cleanReason(noReply[1]) };
  }
  if (!extracted.text) return { kind: "empty" };
  return { kind: "reply", text: extracted.text, wellFormed: extracted.wellFormed, ambiguous: false };
}

/**
 * Junta los `agent.message` de un turno. Antes se usaba SOLO el último mensaje: si el
 * agente escribía el bloque `<respuesta>` y después cerraba con otro mensaje sin bloque
 * (p. ej. tras escribir learnings.md), el bloque se perdía. Ahora gana el último mensaje
 * que trae una marca del protocolo; sin marcas, el último mensaje (como antes).
 * `startTurn()` se llama al mandar una corrección: la nueva salida reemplaza a la vieja.
 */
export class AgentTranscript {
  private lastTagged: string | null = null;
  private lastText = "";

  startTurn(): void {
    this.lastTagged = null;
    this.lastText = "";
  }

  // deno-lint-ignore no-explicit-any
  addMessage(content: any[] | null | undefined): void {
    let text = "";
    for (const block of content ?? []) {
      if (block && block.type === "text" && typeof block.text === "string") text += block.text;
    }
    this.lastText = text;
    if (HAS_PROTOCOL_TAG_RE.test(text)) this.lastTagged = text;
  }

  get text(): string {
    return this.lastTagged ?? this.lastText;
  }
}

/**
 * Corrección en sesión cuando el turno terminó sin texto ni decisión. Español neutro
 * (entra al contexto del modelo; no debe contaminar la voz del operador).
 */
export function emptyOutputCorrectionMessage(): string {
  return [
    "[VERIFICADOR INTERNO — NO es un mensaje del cliente, es una corrección del sistema]",
    "Tu turno terminó sin un mensaje final utilizable (bloque <respuesta> vacío o sin texto).",
    "Elige UNA de estas dos salidas y termina con ella, sin texto después:",
    "1) Si corresponde responder: <respuesta>SOLO el texto que se le envía al cliente</respuesta>",
    "2) Si según tu system prompt o los aprendizajes del operador este mensaje NO debe responderse: <sin_respuesta>motivo breve</sin_respuesta>",
  ].join("\n");
}

/** Instrucción del protocolo de no-respuesta que viaja en el [CONTEXTO] de cada sesión. */
export const NO_REPLY_INSTRUCTION =
  "Si según tu system prompt o los aprendizajes del operador este mensaje NO debe responderse (por ejemplo: solo emojis, una reacción, un sticker, spam o un hilo que el operador pidió no contestar), no inventes una respuesta ni dejes el bloque vacío: terminá con <sin_respuesta>motivo breve</sin_respuesta> en lugar del bloque <respuesta>.";
