// _shared/grader-evidence.ts
// Evidencia que el agente TENÍA al responder, para los graders que verifican hechos
// (no_hallucination: «respaldado por la KB proporcionada como contexto»). Antes el juez
// nunca recibía esa KB: con Haiku 5.5 decía «no se proporcionó KB» y, por el «si dudas,
// baja el score», puntuaba bajo cualquier dato concreto (LAM, oct-2026: 0.71 → 0.38 sin
// que el agente cambiara).
//
// Fuente: los eventos de la sesión CMA del draft (agent_metadata.session_id), que Anthropic
// conserva y se listan con una llamada paginada sin costo de tokens. Es lo más fiel posible:
// el mensaje de contexto exacto que recibió el agente ([CONTEXTO] con aprendizajes,
// promociones, situaciones, [HISTORIAL] y los mensajes nuevos) y el resultado de CADA
// herramienta que usó (search_kb, CRM, Shopify, BCV, http tools, lecturas de su memoria).
// Reconstruirla desde la base (search_kb con el mensaje del lead) sería una aproximación
// que no coincide con lo que el agente realmente consultó.
//
// Seguridad: todo lo que sale de acá es material NO confiable (documentos de la KB,
// respuestas de APIs de terceros, texto del lead dentro del contexto). Este módulo solo
// extrae y acota; quien lo mete al prompt (grader-prompt.ts) lo sanea renglón por renglón
// con referencePreservingLines bajo EVALUATION_NOTICE.

import { stripLoneSurrogates, truncateGraphemes } from "./text-safe.ts";

/** Topes (caracteres UTF-16, cortes por grafema): acotan el costo de cada evaluación. */
export const EVIDENCE_LIMITS = {
  /**
   * Mensaje de contexto que recibió el agente. Se conserva sobre todo el INICIO (fecha,
   * aprendizajes del operador —hasta ~6k con el digest por defecto—, promociones,
   * situaciones) y el final (historial y mensajes nuevos).
   */
  contextChars: 14000,
  /** Fracción del tope de contexto que va al inicio. */
  contextHeadRatio: 0.65,
  /** Resultado de una herramienta. */
  toolResultChars: 4000,
  /** Entrada de una herramienta (la consulta que hizo). */
  toolInputChars: 300,
  /** Suma de resultados de herramientas; lo que excede se cuenta y se avisa. */
  toolsTotalChars: 16000,
  /** Eventos útiles leídos como máximo de una sesión (una sesión normal tiene ~15). */
  maxEvents: 400,
} as const;

/**
 * Tipos de evento que aportan evidencia: se le piden a la API solo esos (filtro `types`
 * de events.list), así no se paginan thinking, spans ni cambios de estado.
 */
export const EVIDENCE_EVENT_TYPES = [
  "user.message",
  "agent.custom_tool_use",
  "user.custom_tool_result",
  "agent.tool_use",
  "agent.tool_result",
  "agent.mcp_tool_use",
  "agent.mcp_tool_result",
] as const;

export type ToolEvidence = { name: string; input: string; result: string };

export type AgentEvidence = {
  /** Contexto que recibió el agente (primer user.message), ya acotado; null si no está. */
  context: string | null;
  /** El contexto se recortó en el medio por tamaño. */
  contextClipped: boolean;
  /** Resultados de herramientas en orden cronológico, ya acotados. */
  tools: ToolEvidence[];
  /** Resultados válidos que no entraron por el tope total. */
  omittedTools: number;
  /** Se dejaron de leer eventos por el tope (puede faltar evidencia posterior). */
  truncatedEvents: boolean;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Texto de un content de evento (string o bloques [{type:"text", text}]), ya en NFKC y
 * sin surrogates sueltos: los topes se miden sobre el texto que realmente llega al prompt
 * (NFKC puede multiplicar el largo: U+FDFA → 18 caracteres).
 */
function textOf(content: unknown): string {
  let raw: string;
  if (typeof content === "string") raw = content;
  else if (!Array.isArray(content)) raw = "";
  else {
    raw = content
      .map((b) => (isRec(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return stripLoneSurrogates(raw).normalize("NFKC");
}

function inputOf(input: unknown): string {
  if (input === undefined || input === null) return "";
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return truncateGraphemes(stripLoneSurrogates(s).normalize("NFKC"), EVIDENCE_LIMITS.toolInputChars, { ellipsis: "…" });
}

/** Resultados que no aportan evidencia: vacíos o el «sin salida» de una escritura. */
function isNoise(text: string): boolean {
  const t = text.trim();
  return t === "" || t === "(no output)";
}

export const CLIP_MARKER = "\n…[recortado por tamaño]…\n";

/**
 * Corta conservando el INICIO y el FINAL (en el contexto del agente arriba están los
 * datos del operador y abajo el historial y los mensajes nuevos), sin partir grafemas.
 * `headRatio`: fracción del espacio que va al inicio.
 */
export function clipMiddle(text: string, max: number, headRatio = 0.5): string {
  const clean = stripLoneSurrogates(String(text ?? ""));
  if (clean.length <= max) return clean;
  const marker = CLIP_MARKER;
  if (max <= marker.length + 2) return truncateGraphemes(clean, max);
  const room = max - marker.length;
  const headMax = Math.floor(room * Math.min(1, Math.max(0, headRatio)));
  const half = room - headMax;
  const head = truncateGraphemes(clean, headMax);
  // Cola: mismos cortes por grafema sobre el texto invertido por grafemas.
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = Array.from(seg.segment(clean), (s) => s.segment);
  let tail = "";
  for (let i = graphemes.length - 1; i >= 0; i--) {
    if (tail.length + graphemes[i].length > half) break;
    tail = graphemes[i] + tail;
  }
  return `${head}${marker}${tail}`;
}

/**
 * Extrae la evidencia de los eventos de una sesión CMA (puro). Empareja cada uso de
 * herramienta con su resultado: custom tools (agent.custom_tool_use → user.custom_tool_result),
 * herramientas del entorno como leer la memoria (agent.tool_use → agent.tool_result) y MCP
 * (agent.mcp_tool_use → agent.mcp_tool_result). Los resultados con error no son evidencia.
 */
export function evidenceFromEvents(events: Iterable<unknown>): AgentEvidence {
  let context: string | null = null;
  let contextClipped = false;
  const uses = new Map<string, { name: string; input: string }>();
  const tools: ToolEvidence[] = [];
  let omittedTools = 0;
  let used = 0;

  for (const raw of events) {
    if (!isRec(raw)) continue;
    const type = String(raw.type ?? "");
    if (type === "user.message") {
      if (context === null) {
        const t = textOf(raw.content);
        if (t.trim()) {
          contextClipped = t.length > EVIDENCE_LIMITS.contextChars;
          context = clipMiddle(t, EVIDENCE_LIMITS.contextChars, EVIDENCE_LIMITS.contextHeadRatio);
        }
      }
      continue;
    }
    if (type === "agent.custom_tool_use" || type === "agent.tool_use" || type === "agent.mcp_tool_use") {
      if (typeof raw.id === "string") {
        uses.set(raw.id, { name: String(raw.name ?? "herramienta"), input: inputOf(raw.input) });
      }
      continue;
    }
    let useId: unknown = null;
    if (type === "user.custom_tool_result") useId = raw.custom_tool_use_id;
    else if (type === "agent.tool_result" || type === "agent.mcp_tool_result") useId = raw.tool_use_id ?? raw.mcp_tool_use_id;
    else continue;
    if (raw.is_error === true) continue;
    const text = textOf(raw.content);
    if (isNoise(text)) continue;
    const use = typeof useId === "string" ? uses.get(useId) : undefined;
    const result = truncateGraphemes(text.trim(), EVIDENCE_LIMITS.toolResultChars, { ellipsis: "…" });
    if (used + result.length > EVIDENCE_LIMITS.toolsTotalChars) {
      omittedTools++;
      continue;
    }
    used += result.length;
    tools.push({ name: use?.name ?? "herramienta", input: use?.input ?? "", result });
  }
  return { context, contextClipped, tools, omittedTools, truncatedEvents: false };
}

/** Lo mínimo del cliente de Anthropic que se usa (permite probar con un falso). */
export type SessionEventsClient = {
  beta: {
    sessions: {
      events: { list(sessionId: string, params?: { types?: string[] }): AsyncIterable<unknown> };
    };
  };
};

/**
 * Lee los eventos de la sesión (paginado por el SDK) hasta EVIDENCE_LIMITS.maxEvents y
 * extrae la evidencia. Lanza si la API falla: el llamador decide (evaluate-outcomes lo
 * registra como ERROR reintentable, nunca evalúa «sin KB» por un fallo transitorio).
 */
export async function fetchSessionEvidence(client: SessionEventsClient, sessionId: string): Promise<AgentEvidence> {
  const events: unknown[] = [];
  let truncatedEvents = false;
  for await (const ev of client.beta.sessions.events.list(sessionId, { types: [...EVIDENCE_EVENT_TYPES] })) {
    if (events.length >= EVIDENCE_LIMITS.maxEvents) {
      truncatedEvents = true;
      break;
    }
    events.push(ev);
  }
  return { ...evidenceFromEvents(events), truncatedEvents };
}
