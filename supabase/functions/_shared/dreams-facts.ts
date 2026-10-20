// _shared/dreams-facts.ts
// Corte DETERMINISTA de datos del negocio en los aprendizajes de Dreams (generación y
// consolidación del digest). Complementa LEARNINGS_DATA_RULE (dreams-digest-block.ts), que
// es una instrucción al modelo y por lo tanto blanda.
//
// Por qué (SuperCines, oct-2026): Dreams aprende de lo que DIJO el agente, y fijó como
// «aprendizajes» datos que solo respaldaba esa repetición: «la sede Playa Mar está cerrada
// por afectación sísmica», «el correo de reclamos es atencion@…», «Cashea desde $25»,
// «horario 9–6». El digest llega al agente con prioridad máxima, así que un dato viejo o
// inventado se realimenta. Un aprendizaje describe CONDUCTA (cómo responder, qué verificar,
// cuándo derivar); los datos salen de las fuentes oficiales.
//
// Qué hace:
//  - Datos con forma reconocible (correos, URLs/dominios, teléfonos, fechas, montos,
//    horarios) → se reemplazan por FACT_PLACEHOLDER: la regla de conducta sobrevive sin el
//    dato.
//  - Afirmaciones de ESTADO o CAUSA (cerrada/suspendida/agotada…, «por afectación sísmica»,
//    «por remodelación»…) → se descarta la ORACIÓN, salvo que sea una instrucción de
//    verificar (verifica/confirma/consulta/revisa/antes de/search_kb).
// Es una red, no un clasificador perfecto: lo que no tenga forma reconocible queda a cargo
// de la regla del prompt.

import { truncateGraphemes } from "./text-safe.ts";

export const FACT_PLACEHOLDER = "[dato: tomarlo de la fuente oficial]";

// Tope por línea ANTES de cualquier regex: el texto viene del modelo y una línea enorme
// (o patológica) no puede volver cuadrático el corte. Un aprendizaje o una viñeta del digest
// son mucho más cortos.
export const MAX_LINE_CHARS = 2000;

const MESES = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
// TLD en MINÚSCULAS y sin flag i: «uses.Es» (fin de oración sin espacio) no es un dominio.
const TLDS = "com|net|org|ve|co|info|io|app|store|shop|mx|ar|cl|pe|ec|es|us|online|site";
// Último carácter de una URL/dominio: nunca la puntuación que cierra la oración.
const URL_END = "[^\\s)»\"'.,;:!?]";
// Sustantivos de CANTIDAD: «2-3 oraciones», «2 a 3 opciones», «3-5 minutos» no son horarios.
const COUNT_NOUNS =
  "oraciones|frases|l[ií]neas|p[aá]rrafos|opciones|mensajes|funciones|minutos|segundos|veces|d[ií]as|preguntas|palabras|pasos|respuestas|emojis";
const HOUR_UNIT = "(?:a\\.\\s?m\\.|p\\.\\s?m\\.|am\\b|pm\\b|hrs?\\b|hs\\b|horas\\b|h\\b)";

type TokenPattern = { re: RegExp; valid?: (m: string) => boolean };

// Orden importa: lo más específico primero (un correo contiene un dominio; una fecha ISO
// parece un teléfono; un rango de horas contiene dos horas). Todos los cuantificadores están
// ACOTADOS y los que pueden empezar en cualquier posición llevan lookbehind: nada cuadrático.
const TOKEN_PATTERNS: readonly TokenPattern[] = [
  { re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,5}\.[A-Za-z]{2,24}\b/g },
  { re: new RegExp(`\\bhttps?:\\/\\/[^\\s)»"']{0,300}${URL_END}|\\bwww\\.[^\\s)»"']{0,300}${URL_END}`, "gi") },
  {
    re: new RegExp(
      `(?<![A-Za-z0-9.-])[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){0,5}\\.(?:${TLDS})\\b(?:\\/[^\\s)»"']{0,300}${URL_END})?`,
      "g",
    ),
  },
  { re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { re: /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g },
  { re: new RegExp(`\\b\\d{1,2}\\s{1,3}de\\s{1,3}(?:${MESES})(?:\\s{1,3}(?:de|del)\\s{1,3}\\d{4})?\\b`, "gi") },
  // Montos: símbolo o moneda antes o después de la cifra.
  { re: /(?:\bUS\$|\$|\bUSD\b|\bBs\.?\s?S?\.?|€|\bS\/\.?)\s?\d(?:[\d.,]{0,15}\d)?/gi },
  { re: /(?<![\d.,])\d(?:[\d.,]{0,15}\d)?\s?(?:\$|USD\b|d[oó]lares\b|bol[ií]vares\b|Bs\b\.?|euros\b|€)/gi },
  // Horas: rango con dos puntos; rango CLARO con unidad («de 9 a 6 pm», «10 a 22 horas»);
  // hora con am/pm/h; hora con dos puntos.
  { re: /\b\d{1,2}:\d{2}\s{0,3}(?:[–—-]|a|hasta)\s{0,3}\d{1,2}:\d{2}\b/gi },
  { re: new RegExp(`\\b(?:de\\s{1,3})?\\d{1,2}(?::\\d{2})?\\s{0,3}(?:[–—-]|a|hasta)\\s{0,3}\\d{1,2}(?::\\d{2})?\\s{0,2}${HOUR_UNIT}`, "gi") },
  { re: /\b\d{1,2}(?::\d{2})?\s?(?:a\.\s?m\.|p\.\s?m\.|am\b|pm\b|hrs?\b|hs\b)/gi },
  { re: /\b\d{1,2}:\d{2}\b/g },
  // Teléfonos: 7+ dígitos REALES (con separadores). «1. 2. 3.» o «2 - 3» no lo son.
  { re: /(?<![\d+])\+?\d[\d\s().-]{5,18}\d/g, valid: (m) => (m.match(/\d/g)?.length ?? 0) >= 7 },
];

// Rango de horas sin unidad ni dos puntos («horario 9–6»): solo con contexto de horario, con
// números que pueden ser horas y NUNCA seguido de un sustantivo de cantidad («responde en 2-3
// oraciones», «ofrece 2 a 3 opciones»).
const HOUR_RANGE = new RegExp(
  `\\b(?:[01]?\\d|2[0-4])\\s{0,3}(?:[–—-]|a|hasta)\\s{0,3}(?:[01]?\\d|2[0-4])\\b(?!\\s{0,3}(?:${COUNT_NOUNS}))`,
  "gi",
);
const SCHEDULE_CONTEXT =
  /\b(horarios?|abre|abren|abrimos|apertura|atiende|atienden|atendemos|taquilla|funciona|funcionan|opera|operan)\b/i;

const STATE_WORD =
  "(?:cerrad[oa]s?|clausurad[oa]s?|inhabilitad[oa]s?|suspendid[oa]s?|inoperativ[oa]s?|fuera de servicio|sin servicio|agotad[oa]s?|no disponibles?)";
// Fin de palabra que funciona con tildes (\b no las conoce sin el flag u).
const WEND = "(?![A-Za-zÁÉÍÓÚÜáéíóúüÑñ])";
// Estado + causa («cerrada por …», «suspendida debido a …»).
const STATE_WITH_CAUSE = new RegExp(`\\b${STATE_WORD}\\b.{0,40}?\\b(?:por|debido a|a causa de)\\b`, "i");
// Causa típica de un cierre…
const CAUSE = /\b(afectaci[oó]n|s[ií]smic[oa]s?|sismo|terremoto|inundaci[oó]n|remodelaci[oó]n)\b/i;
// …que solo cuenta si la oración AFIRMA algo: un estado o un verbo de estado («sufrió
// afectación sísmica», «tiene remodelación»). Mencionar la causa («cuando el lead mencione el
// sismo») no es afirmarla.
const CAUSE_VERB = new RegExp(
  `(?:\\b${STATE_WORD}${WEND}|\\b(?:está|están|esta|estan|se encuentran?|permanecen?|siguen?|quedó|quedaron|continúan?|sufri[oó]|sufre|sufren|sufrieron|tienen?|presentan?|afectad[oa]s?|hubo|hay)${WEND})`,
  "i",
);
// Afirmación de estado con verbo («está cerrada», «siguen agotados»).
const STATE_ASSERTION = new RegExp(
  `\\b(?:está|están|esta|estan|se encuentran?|permanecen?|siguen?|quedó|quedaron|continúan?)\\s+(?:temporalmente\\s+)?${STATE_WORD}`,
  "i",
);
// Instrucción de verificar: lo que se pide es una CONDUCTA, no se afirma el estado.
const VERIFY = /\b(verific\w*|confirm\w*|consult\w*|revis\w*|comprueb\w*|chequea\w*|antes de|search_kb)\b/i;
// Cláusula condicional («si el lead dice que está agotada», «cuando reporte una afectación»):
// describe lo que PASA o lo que DICE el lead, no afirma nada. Se quita hasta la coma; lo que
// queda (la consecuencia: «…, di que permanece cerrada por …») se sigue evaluando.
const CONDITIONAL = /\b(?:si|cuando|en caso de(?: que)?|siempre que)\b[^,;:]{0,400}/gi;

function withoutConditionals(sentence: string): string {
  return sentence.replace(CONDITIONAL, " ");
}

function assertsCause(s: string): boolean {
  return STATE_WITH_CAUSE.test(s) || (CAUSE.test(s) && CAUSE_VERB.test(s));
}

function assertsStateOrCause(sentence: string): boolean {
  if (VERIFY.test(sentence)) return false;
  const s = withoutConditionals(sentence);
  return assertsCause(s) || STATE_ASSERTION.test(s);
}

function capLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? truncateGraphemes(line, MAX_LINE_CHARS) : line;
}

function redactTokens(line: string): { text: string; redacted: number } {
  let redacted = 0;
  let text = capLine(line);
  const sub = (re: RegExp, valid?: (m: string) => boolean) => {
    text = text.replace(re, (m: string) => {
      if (valid && !valid(m)) return m;
      redacted++;
      return FACT_PLACEHOLDER;
    });
  };
  const schedule = SCHEDULE_CONTEXT.test(text);
  for (const p of TOKEN_PATTERNS) sub(p.re, p.valid);
  // Después de las horas con dos puntos («9:00 a 18:00» ya es un solo marcador).
  if (schedule) sub(HOUR_RANGE);
  return { text, redacted };
}

const BULLET = /^(\s*(?:[-*•]|\d+[.)])\s+)/;
const HEADING = /^\s*#{1,6}\s/;

export type NeutralizeResult = { text: string; redacted: number; dropped: number };

/**
 * Neutraliza los datos del negocio de un texto (aprendizaje o digest): reemplaza los datos
 * con forma reconocible y descarta las oraciones que afirman un estado o su causa. Conserva
 * la estructura por líneas (encabezados, viñetas); una viñeta que queda vacía se quita.
 */
export function neutralizeBusinessFacts(input: string): NeutralizeResult {
  let redacted = 0;
  let dropped = 0;
  const out: string[] = [];
  for (const raw of String(input ?? "").split("\n")) {
    if (!raw.trim()) {
      out.push(raw);
      continue;
    }
    const r = redactTokens(raw);  // redactTokens ya acota la línea a MAX_LINE_CHARS
    redacted += r.redacted;
    if (HEADING.test(r.text)) {
      out.push(r.text);
      continue;
    }
    const prefix = r.text.match(BULLET)?.[1] ?? "";
    const body = r.text.slice(prefix.length);
    const sentences = body.split(/(?<=[.!?;])\s+/);
    const kept = sentences.filter((s) => {
      if (assertsStateOrCause(s)) {
        dropped++;
        return false;
      }
      return true;
    });
    if (kept.length === 0) continue;
    out.push(prefix + kept.join(" "));
  }
  // Sin líneas en blanco sobrantes en los bordes.
  return { text: out.join("\n").trim(), redacted, dropped };
}

export type LearningFields = { title: string; content: string; evidence: string };

/**
 * Aplica neutralizeBusinessFacts a un learning recién generado. Devuelve null si el
 * aprendizaje ERA un dato del negocio (el título afirma la causa de un estado o el contenido queda
 * vacío): no se guarda. Sin cambios, devuelve el mismo objeto.
 */
export function neutralizeLearning<L extends LearningFields>(l: L): L | null {
  const titleText = capLine(String(l.title ?? "")).replace(/[_-]+/g, " ");
  // El título solo descarta el aprendizaje si afirma una CAUSA de un estado («sede cerrada
  // por afectación sísmica»): un título con «agotada» («funcion_agotada_ofrecer_alternativa»)
  // nombra la situación, y la conducta del contenido se evalúa aparte.
  if (!VERIFY.test(titleText) && assertsCause(withoutConditionals(titleText))) return null;
  const title = redactTokens(titleText);
  const content = neutralizeBusinessFacts(l.content);
  if (!content.text) return null;
  const evidence = neutralizeBusinessFacts(l.evidence);
  if (title.redacted + content.redacted + content.dropped + evidence.redacted + evidence.dropped === 0) return l;
  return {
    ...l,
    title: title.redacted ? title.text.replace(/\[dato: tomarlo de la fuente oficial\]/g, "dato oficial") : l.title,
    content: content.text,
    evidence: evidence.text || "(evidencia omitida: afirmaba datos del negocio)",
  };
}
