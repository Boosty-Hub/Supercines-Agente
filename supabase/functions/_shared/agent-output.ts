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
// El protocolo tiene dos salidas explícitas:
//   <respuesta>texto para el lead</respuesta>      → se responde
//   <sin_respuesta>motivo breve</sin_respuesta>    → no se responde, a propósito
// Un bloque vacío o ningún texto NO es una decisión: se le pide al agente, en la misma
// sesión, que elija una de las dos. Si aun así no decide, recién ahí es una falla.
//
// UN SOLO PARSE (revisión de seguridad): la decisión, el texto extraído y «qué mensaje
// cuenta» salen del MISMO tokenizado de las marcas (`parseProtocol`). Antes había regex
// sueltas con criterios distintos: un `<respuesta>` escrito DENTRO del motivo de un
// `<sin_respuesta>` hacía creer que había bloque de respuesta y se devolvía el texto
// crudo (razonamiento interno) como si fuera la respuesta. Regla: el texto de una
// respuesta SIEMPRE sale de adentro de un bloque `<respuesta>`; jamás del crudo.

/** Tope del motivo que se guarda (es texto del modelo: solo para el panel y los logs). */
export const NO_REPLY_REASON_MAX = 300;

export type AgentDecision =
  /** Exactamente un bloque <respuesta> bien formado con contenido. */
  | { kind: "reply"; text: string }
  /** El agente decidió explícitamente no responder (y no hay bloque de respuesta con contenido). */
  | { kind: "no_reply"; reason: string }
  /** Ni texto ni decisión: bloque vacío, sin mensajes, o solo tool_use/thinking. */
  | { kind: "empty" }
  /**
   * Salida que no cumple el protocolo. `rescue` es texto que estaba DENTRO de un bloque
   * <respuesta> (o del shape `name="respuesta"`), nunca el crudo; null si no hay. Nunca se
   * auto-envía: se reprocesa y, si persiste, va a revisión humana (o falla sin rescate).
   * `allowNoReply`: la corrección puede ofrecer <sin_respuesta> (no hubo respuesta clara).
   */
  | { kind: "malformed"; reason: string; rescue: string | null; allowNoReply: boolean };

type Tag = "respuesta" | "sin_respuesta";
type Token = { tag: Tag; closing: boolean; selfClosing: boolean; start: number; end: number };
type Block = { tag: Tag; content: string };

/** Marcas del protocolo, solo ASCII; espacios y mayúsculas tolerados. */
const TAG_RE = /<\s*(\/)?\s*(respuesta|sin_respuesta)\s*(\/)?\s*>/gi;
/** Shape de parámetro de tool-call observado en producción. */
const PARAM_RE = /<\s*parameter\s+name\s*=\s*"respuesta"\s*>([\s\S]*?)(?:<\s*\/\s*parameter\s*>|$)/i;

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(TAG_RE)) {
    out.push({
      tag: m[2].toLowerCase() as Tag,
      closing: m[1] === "/",
      selfClosing: m[3] === "/",
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }
  return out;
}

export type ProtocolParse = {
  /** Bloques cerrados, en orden. */
  blocks: Block[];
  /** null = estructura válida; si no, el motivo. */
  error: string | null;
  /** Contenido de un <respuesta> abierto sin cerrar al final (o del shape name="respuesta"). */
  openReply: string | null;
  /** ¿Hubo alguna marca del protocolo (incluidas lookalikes)? */
  hasMarkers: boolean;
};

/** Tokeniza UNA vez y arma los bloques; anidar, cerrar sin abrir o usar lookalikes es error. */
export function parseProtocol(raw: string | null | undefined): ProtocolParse {
  const s = String(raw ?? "");
  const tokens = tokenize(s);
  // Marcas con caracteres no ASCII que se ven igual (＜respuesta＞): las detecta NFKC.
  // No se interpretan (sería otro parser), pero tampoco pasan como texto normal.
  const lookalike = tokenize(s.normalize("NFKC")).length !== tokens.length;
  const param = s.match(PARAM_RE);
  const res: ProtocolParse = { blocks: [], error: null, openReply: null, hasMarkers: tokens.length > 0 || lookalike || !!param };
  if (lookalike) {
    res.error = "trae etiquetas del protocolo escritas con caracteres no ASCII";
    return res;
  }
  let open: Token | null = null;
  for (const t of tokens) {
    if (t.selfClosing) {
      if (open) return { ...res, error: `etiqueta <${t.tag}/> dentro de un bloque <${open.tag}>` };
      if (t.closing) return { ...res, error: `etiqueta inválida </${t.tag}/>` };
      res.blocks.push({ tag: t.tag, content: "" });
      continue;
    }
    if (!t.closing) {
      if (open) return { ...res, error: `bloque <${t.tag}> dentro de un bloque <${open.tag}>` };
      open = t;
      continue;
    }
    if (!open) return { ...res, error: `cierre </${t.tag}> sin apertura` };
    if (open.tag !== t.tag) return { ...res, error: `bloque <${open.tag}> cerrado con </${t.tag}>` };
    res.blocks.push({ tag: t.tag, content: s.slice(open.end, t.start) });
    open = null;
  }
  if (open) {
    res.error = `bloque <${open.tag}> sin cerrar`;
    if (open.tag === "respuesta") res.openReply = s.slice(open.end);
    return res;
  }
  if (param && tokens.length === 0) {
    res.error = 'el bloque vino con forma de parámetro (name="respuesta") en vez de <respuesta>';
    res.openReply = param[1];
  }
  return res;
}

/** ¿El texto trae alguna marca del protocolo? (mismo parser que la decisión) */
export function hasProtocolMarkers(raw: string | null | undefined): boolean {
  return parseProtocol(raw).hasMarkers;
}

function cleanReason(raw: string): string {
  const r = raw.replace(/\s+/g, " ").trim();
  if (!r) return "sin motivo indicado";
  return r.length > NO_REPLY_REASON_MAX ? `${r.slice(0, NO_REPLY_REASON_MAX - 1)}…` : r;
}

/** Decide qué hizo el agente a partir del texto de su mensaje final. */
export function decideAgentOutput(raw: string | null | undefined): AgentDecision {
  const s = String(raw ?? "");
  const p = parseProtocol(s);
  if (p.error) {
    const rescue = p.openReply?.trim() || null;
    return { kind: "malformed", reason: p.error, rescue, allowNoReply: true };
  }
  if (!p.hasMarkers) {
    if (!s.trim()) return { kind: "empty" };
    // Texto sin ninguna marca (p. ej. un análisis «no respondo»): sin bloque no hay
    // respuesta que rescatar; el crudo NUNCA se usa como texto para el lead.
    return { kind: "malformed", reason: "el bloque <respuesta>...</respuesta> vino ausente", rescue: null, allowNoReply: true };
  }
  const replies = p.blocks.filter((b) => b.tag === "respuesta" && b.content.trim());
  const noReplies = p.blocks.filter((b) => b.tag === "sin_respuesta");
  if (noReplies.length > 0 && replies.length === 0) {
    return { kind: "no_reply", reason: cleanReason(noReplies.map((b) => b.content).join(" · ")) };
  }
  if (noReplies.length > 0) {
    return {
      kind: "malformed",
      reason: "trae a la vez <respuesta> y <sin_respuesta>",
      rescue: replies[replies.length - 1].content.trim(),
      allowNoReply: true,
    };
  }
  if (replies.length > 1) {
    return {
      kind: "malformed",
      reason: "trae más de un bloque <respuesta>",
      rescue: replies[replies.length - 1].content.trim(),
      allowNoReply: false,
    };
  }
  if (replies.length === 1) return { kind: "reply", text: replies[0].content.trim() };
  return { kind: "empty" };
}

/**
 * Junta los `agent.message` de un turno. Antes se usaba SOLO el último mensaje: si el
 * agente escribía el bloque `<respuesta>` y después cerraba con otro mensaje sin bloque
 * (p. ej. tras escribir learnings.md), el bloque se perdía. Ahora gana el último mensaje
 * con marcas del protocolo (mismo parser que la decisión); sin marcas, el último.
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
    if (hasProtocolMarkers(text)) this.lastTagged = text;
  }

  get text(): string {
    return this.lastTagged ?? this.lastText;
  }
}

/**
 * Corrección en sesión cuando el turno terminó sin texto ni decisión. Español neutro con
 * tuteo (entra al contexto del modelo; no debe contaminar la voz de ningún operador).
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

/** Instrucción del protocolo de no-respuesta que viaja en el [CONTEXTO] de cada sesión (tuteo). */
export const NO_REPLY_INSTRUCTION =
  "Si según tu system prompt o los aprendizajes del operador este mensaje NO debe responderse (por ejemplo: solo emojis, una reacción, un sticker, spam o un hilo que el operador pidió no contestar), no inventes una respuesta ni dejes el bloque vacío: termina con <sin_respuesta>motivo breve</sin_respuesta> en lugar del bloque <respuesta>.";
