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
//    horarios) → se reemplazan por un marcador (FACT_PLACEHOLDER; horas: SCHEDULE_PLACEHOLDER;
//    «24/7»: AVAILABILITY_PLACEHOLDER): la regla de conducta sobrevive sin el dato. Se prefiere
//    SIEMPRE reemplazar el token a descartar la oración (Veterinaria, oct-2026: «24/7» se llevaba
//    oraciones enteras y dejaba huérfanas las siguientes).
//  - Afirmaciones de ESTADO o CAUSA (cerrada/suspendida/agotada…, «por afectación sísmica»,
//    «por remodelación»…) → se descarta la ORACIÓN, salvo que sea una instrucción de
//    verificar (verifica/confirma/consulta/revisa/antes de/search_kb).
// Es una red, no un clasificador perfecto: lo que no tenga forma reconocible queda a cargo
// de la regla del prompt.

import { truncateGraphemes } from "./text-safe.ts";

export const FACT_PLACEHOLDER = "[dato: tomarlo de la fuente oficial]";
/**
 * Marcador de un HORARIO quitado («de 8:00 am a 12:00 pm», «9–6», «10am»). Distinto del genérico
 * porque su frase natural hacia el agente es otra (agentFacingFacts → AGENT_SCHEDULE_PHRASE):
 * «oftalmología se atiende lunes a viernes de [dato…]» quedaba «… de los canales oficiales»
 * (Veterinaria, oct-2026), que es un canal, no un horario.
 */
export const SCHEDULE_PLACEHOLDER = "[dato: horario de la fuente oficial]";
/**
 * Marcador de una DISPONIBILIDAD quitada («24/7», «las 24 horas», «24h al día»). Es un dato de
 * horario del negocio (no una fecha: antes «24/7» caía en el patrón de fechas y la oración entera
 * desaparecía): se reemplaza SOLO el token por AGENT_AVAILABILITY_PHRASE y la oración queda.
 */
export const AVAILABILITY_PLACEHOLDER = "[dato: disponibilidad de la fuente oficial]";

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

/** Formas de dato de ALTO RIESGO en la salida de la consolidación (highRiskDataShapes). */
export type DataShapeKind = "email" | "url" | "phone" | "money";

type TokenPattern = {
  re: RegExp;
  valid?: (m: string) => boolean;
  kind?: DataShapeKind;
  date?: true;
  /** Marcador que deja (por defecto FACT_PLACEHOLDER). */
  placeholder?: string;
};

// Disponibilidad («24/7», «las 24 horas», «24h al día», «24 horas los 7 días»): ANTES que las
// fechas («24/7» no es el 24 de julio) y que las horas. «24 horas» / «24h» SOLO con «las» delante
// o un complemento de disponibilidad detrás: suelto es una duración («responde en 24 horas», «un
// ayuno de 24 h») y no se toca.
const AVAIL_SUFFIX =
  "(?:\\s{1,3}(?:al|del)\\s{1,3}d[ií]a|\\s{1,3}(?:los|todos\\s{1,3}los)\\s{1,3}(?:7|siete)?\\s{0,3}d[ií]as(?:\\s{1,3}de\\s{1,3}la\\s{1,3}semana)?|\\s{0,2}\\/\\s{0,2}7(?![\\d/]))";
const AVAILABILITY = new RegExp(
  `(?<![\\d/])24\\s{0,2}\\/\\s{0,2}7(?:\\s{0,2}\\/\\s{0,2}365)?(?![\\d/])` +
    `|\\blas\\s{1,3}24\\s{0,2}(?:horas|hrs?|hs|h)\\b${AVAIL_SUFFIX}?` +
    `|(?<![\\d.,:])\\b24\\s{0,2}(?:horas|hrs?|hs|h)\\b${AVAIL_SUFFIX}`,
  "gi",
);

// Orden importa: lo más específico primero (un correo contiene un dominio; una fecha ISO
// parece un teléfono; un rango de horas contiene dos horas). Todos los cuantificadores están
// ACOTADOS y los que pueden empezar en cualquier posición llevan lookbehind: nada cuadrático.
const TOKEN_PATTERNS: readonly TokenPattern[] = [
  { re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,5}\.[A-Za-z]{2,24}\b/g, kind: "email" },
  { re: new RegExp(`\\bhttps?:\\/\\/[^\\s)»"']{0,300}${URL_END}|\\bwww\\.[^\\s)»"']{0,300}${URL_END}`, "gi"), kind: "url" },
  {
    re: new RegExp(
      `(?<![A-Za-z0-9.-])[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){0,5}\\.(?:${TLDS})\\b(?:\\/[^\\s)»"']{0,300}${URL_END})?`,
      "g",
    ),
    kind: "url",
  },
  { re: AVAILABILITY, placeholder: AVAILABILITY_PLACEHOLDER },
  { re: /\b\d{4}-\d{2}-\d{2}\b/g, date: true },
  { re: /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, date: true },
  { re: new RegExp(`\\b\\d{1,2}\\s{1,3}de\\s{1,3}(?:${MESES})(?:\\s{1,3}(?:de|del)\\s{1,3}\\d{4})?\\b`, "gi"), date: true },
  // Montos: símbolo o moneda antes o después de la cifra.
  { re: /(?:\bUS\$|\$|\bUSD\b|\bBs\.?\s?S?\.?|€|\bS\/\.?)\s?\d(?:[\d.,]{0,15}\d)?/gi, kind: "money" },
  { re: /(?<![\d.,])\d(?:[\d.,]{0,15}\d)?\s?(?:\$|USD\b|d[oó]lares\b|bol[ií]vares\b|Bs\b\.?|euros\b|€)/gi, kind: "money" },
  // Horas: rango con dos puntos; rango CLARO con unidad («de 9 a 6 pm», «10 a 22 horas»);
  // hora con am/pm/h; hora con dos puntos.
  // «24 hrs» suelto es una duración (la disponibilidad ya se tomó arriba): no es una hora.
  { re: /\b\d{1,2}:\d{2}\s{0,3}(?:[–—-]|a|hasta)\s{0,3}\d{1,2}:\d{2}\b/gi, placeholder: SCHEDULE_PLACEHOLDER },
  {
    re: new RegExp(`\\b\\d{1,2}(?::\\d{2})?\\s{0,3}(?:[–—-]|a|hasta)\\s{0,3}\\d{1,2}(?::\\d{2})?\\s{0,2}${HOUR_UNIT}`, "gi"),
    placeholder: SCHEDULE_PLACEHOLDER,
  },
  { re: /\b(?!24\s?(?:hrs?|hs)\b)\d{1,2}(?::\d{2})?\s?(?:a\.\s?m\.|p\.\s?m\.|am\b|pm\b|hrs?\b|hs\b)/gi, placeholder: SCHEDULE_PLACEHOLDER },
  { re: /\b\d{1,2}:\d{2}\b/g, placeholder: SCHEDULE_PLACEHOLDER },
  // Teléfonos: 7+ dígitos REALES (con separadores). «1. 2. 3.» o «2 - 3» no lo son.
  { re: /(?<![\d+])\+?\d[\d\s().-]{5,18}\d/g, valid: (m) => (m.match(/\d/g)?.length ?? 0) >= 7, kind: "phone" },
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

// Lugar o servicio del NEGOCIO: una causa sin palabra de estado («sufrió afectación sísmica»)
// solo es un dato del negocio si habla de uno. «Animales en La Guaira que sufrieron el terremoto»
// (Veterinaria, oct-2026) es contexto del caso, no el estado de una sede: no se descarta.
const BUSINESS_PLACE =
  /\b(?:sedes?|sucursal(?:es)?|locales?|tiendas?|cl[ií]nicas?|cines?|oficinas?|agencias?|centros?|instalaciones|taquillas?|servicios?|salas?|plantas?|negocios?|establecimientos?|edificios?|concesionarios?)\b/i;

function assertsCause(s: string): boolean {
  return STATE_WITH_CAUSE.test(s) || (CAUSE.test(s) && CAUSE_VERB.test(s) && BUSINESS_PLACE.test(s));
}

function assertsStateOrCause(sentence: string): boolean {
  if (VERIFY.test(sentence)) return false;
  const s = withoutConditionals(sentence);
  return assertsCause(s) || STATE_ASSERTION.test(s);
}

function capLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? truncateGraphemes(line, MAX_LINE_CHARS) : line;
}

const INVISIBLE_FORMAT = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function redactTokens(line: string, opts: { keepDates?: boolean } = {}): { text: string; redacted: number } {
  let redacted = 0;
  // Invisibles y de formato FUERA antes de buscar datos: «0414\u200B123\u20604567» no debe
  // esquivar el patrón de teléfono, y el centinela de las fechas conservadas (U+2060, abajo)
  // nunca puede venir de la entrada: si no, el borrado final reconstruiría un dato del atacante.
  let text = capLine(line).replace(INVISIBLE_FORMAT, "");
  const sub = (re: RegExp, valid?: (m: string) => boolean, placeholder = FACT_PLACEHOLDER) => {
    text = text.replace(re, (m: string) => {
      if (valid && !valid(m)) return m;
      redacted++;
      return placeholder;
    });
  };
  // Sin los marcadores: «[dato: horario …]» no es contexto de horario (idempotencia).
  const schedule = SCHEDULE_CONTEXT.test(text.replace(MARKER_ANY, " "));
  for (const p of TOKEN_PATTERNS) {
    // Una fecha conservada se consume como neutra: «2026-10-19» no puede leerse después
    // como teléfono ni «19/10» como otra forma.
    if (p.date && opts.keepDates) text = text.replace(p.re, (m: string) => m.replace(/\d/g, "\u2060$&"));
    else sub(p.re, p.valid, p.placeholder);
  }
  // Después de las horas con dos puntos («9:00 a 18:00» ya es un solo marcador).
  if (schedule) sub(HOUR_RANGE, undefined, SCHEDULE_PLACEHOLDER);
  if (opts.keepDates) text = text.replace(/\u2060/g, "");
  return { text, redacted };
}

const BULLET = /^(\s*(?:[-*•]|\d+[.)])\s+)/;

// ─── Corte en oraciones ─────────────────────────────────────────────────────
// Un solo cortador para el descarte de estados y para la red del marcador (agentFacingLine) y
// el render. Corta tras «.», «!», «?» o «;» seguido de espacio, aunque entre ellos haya comillas
// o un paréntesis de cierre («…de rescates." Derivar…»: Veterinaria 22f216b). NUNCA corta:
//  - dentro de comillas o paréntesis («'Sin poder verlo, no puedo recomendar... necesita…'»): la
//    cita es UNA unidad; cortarla dejaba citas abiertas y frases a medias;
//  - tras puntos suspensivos («...», «…»);
//  - tras una abreviatura («p. ej.», «Dr.», «Sra.»).
// Si las comillas o los paréntesis no cierran en el renglón, se corta sin tenerlos en cuenta
// (una comilla suelta no puede volver el renglón entero una sola oración).
const CLOSERS = new Set(['"', "'", "»", "”", "’", ")", "]"]);
const ABBREVIATION = /(?:^|[\s(])(?:p|ej|dr|dra|sr|sra|srta|ud|uds|aprox|tel|av|n[uú]m|p[aá]g|vs|lic|ing)\.$/i;

function splitOnce(text: string, track: boolean): { parts: string[]; balanced: boolean } {
  const parts: string[] = [];
  let start = 0;
  let guillemets = 0; // « » y “ ”
  let parens = 0;
  let dq = false; // "
  let sq = false; // ' como comilla (no el apóstrofo dentro de una palabra)
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (track) {
      if (c === "«" || c === "“") guillemets++;
      else if ((c === "»" || c === "”") && guillemets > 0) guillemets--;
      else if (c === "(") parens++;
      else if (c === ")" && parens > 0) parens--;
      else if (c === '"') dq = !dq;
      else if (c === "'" || c === "‘" || c === "’") {
        const prev = i > 0 ? text[i - 1] : " ";
        const next = i + 1 < text.length ? text[i + 1] : " ";
        if (!sq && /[\s(«“"—–-]/.test(prev) && /\S/.test(next)) sq = true;
        else if (sq && /\S/.test(prev) && /[\s.,;:!?)»”"]/.test(next)) sq = false;
      }
    }
    if (!/\s/.test(c) || i === start) continue;
    let j = i - 1;
    while (j > start && CLOSERS.has(text[j]) && i - 1 - j < 3) j--;
    const p = text[j];
    if (!/[.!?;]/.test(p)) continue;
    if (p === "." && (text[j - 1] === "." || ABBREVIATION.test(text.slice(Math.max(start, j - 8), j + 1)))) continue;
    if (track && (guillemets > 0 || parens > 0 || dq || sq)) continue;
    parts.push(text.slice(start, i));
    while (i + 1 < text.length && /\s/.test(text[i + 1])) i++;
    start = i + 1;
  }
  if (start < text.length) parts.push(text.slice(start));
  return { parts, balanced: guillemets === 0 && parens === 0 && !dq && !sq };
}

/** Oraciones o cláusulas de un renglón (sin el espacio que las separa). */
export function splitSentences(text: string): string[] {
  const s = String(text ?? "");
  const tracked = splitOnce(s, true);
  return tracked.balanced ? tracked.parts : splitOnce(s, false).parts;
}

// Oración que REMITE a la anterior («Esto acelera la acción sin rodeos.», «Mantener este orden en
// futuras respuestas.», «Así evitas…»): si la anterior se descartó, sola queda huérfana y sin
// sentido (Veterinaria, oct-2026) → se descarta con ella.
const ANAPHORIC =
  /^[\s"'«“(¡¿*]{0,4}(?:esto|eso|ello|aquello|así|este|esta|estos|estas|ese|esa|esos|esas|de\s+(?:esa|esta|ese|este)\s+(?:forma|manera|modo)|de\s+ese\s+modo|por\s+(?:eso|ello|esto)|(?:mantener|mantén|mantenga|conservar|conserva|seguir|sigue|repetir|repite|replicar|replica)\s+(?:este|esta|estos|estas|ese|esa|esos|esas|dicho|dicha))(?![A-Za-zÁÉÍÓÚÜáéíóúüÑñ])/i;

/** La oración remite a la anterior (no se sostiene sola si la anterior se quitó). */
export function isAnaphoric(sentence: string): boolean {
  return ANAPHORIC.test(sentence);
}
const HEADING = /^\s*#{1,6}\s/;

export type NeutralizeResult = { text: string; redacted: number; dropped: number };

export type NeutralizeOptions = {
  /**
   * La oración descartada deja FACT_PLACEHOLDER en su lugar en vez de desaparecer. Lo usa la
   * ENTRADA de la consolidación (dreams-consolidation.ts → consolidationInput): el modelo ve
   * que ahí había un dato y escribe él mismo la regla de conducta que remite a la fuente
   * oficial. La generación (neutralizeLearning) no lo usa: descarta como siempre.
   */
  markDropped?: boolean;
  /**
   * Conserva las fechas (ISO, «19/10», «19 de octubre»). Solo para la EVIDENCIA de un learning
   * (neutralizeLearning): ahí una fecha es un metadato (cuándo pasó), no una afirmación del
   * negocio, y no llega al agente (el digest no lleva la evidencia: dreams-digest-render.ts).
   * LAM, oct-2026: «el 19-oct el agente…» quedaba «[dato: …] el agente…».
   */
  keepDates?: boolean;
};

// Una oración que queda AL FINAL tras descartar las siguientes no puede quedar colgando en
// «;», «:» o «,» («No digas que abre el domingo;»): se cierra con punto.
const DANGLING_END = /\s*[;:,]\s*$/;

function closeDangling(sentence: string): string {
  return DANGLING_END.test(sentence) ? sentence.replace(DANGLING_END, ".") : sentence;
}

/**
 * Neutraliza los datos del negocio de un texto (aprendizaje o digest): reemplaza los datos
 * con forma reconocible y descarta las oraciones que afirman un estado o su causa. Conserva
 * la estructura por líneas (encabezados, viñetas); una viñeta que queda vacía se quita.
 */
export function neutralizeBusinessFacts(input: string, opts: NeutralizeOptions = {}): NeutralizeResult {
  let redacted = 0;
  let dropped = 0;
  const out: string[] = [];
  for (const raw of String(input ?? "").split("\n")) {
    if (!raw.trim()) {
      out.push(raw);
      continue;
    }
    const r = redactTokens(raw, { keepDates: opts.keepDates });  // redactTokens ya acota la línea a MAX_LINE_CHARS
    redacted += r.redacted;
    if (HEADING.test(r.text)) {
      out.push(r.text);
      continue;
    }
    const prefix = r.text.match(BULLET)?.[1] ?? "";
    const body = r.text.slice(prefix.length);
    const sentences = splitSentences(body);
    const kept: string[] = [];
    let lineDropped = false;
    let prevDropped = false;
    for (const s of sentences) {
      // Lo que remite a una oración descartada se va con ella (no queda huérfano).
      const orphan: boolean = prevDropped && isAnaphoric(s);
      prevDropped = orphan || assertsStateOrCause(s);
      if (!prevDropped) {
        kept.push(s);
        continue;
      }
      dropped++;
      lineDropped = true;
      // Marcador en lugar de la oración (con su cierre), uno solo por tramo descartado.
      if (opts.markDropped && !kept.at(-1)?.startsWith(FACT_PLACEHOLDER)) {
        kept.push(FACT_PLACEHOLDER + (s.trimEnd().match(/[.!?;]$/)?.[0] ?? "."));
      }
    }
    if (kept.length === 0) continue;
    if (lineDropped) kept[kept.length - 1] = closeDangling(kept[kept.length - 1]);
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
  const evidence = neutralizeBusinessFacts(l.evidence, { keepDates: true });
  if (title.redacted + content.redacted + content.dropped + evidence.redacted + evidence.dropped === 0) return l;
  return {
    ...l,
    title: title.redacted ? title.text.replace(MARKER_ANY, "dato oficial") : l.title,
    content: content.text,
    evidence: evidence.text || "(evidencia omitida: afirmaba datos del negocio)",
  };
}

// ─── El marcador hacia afuera ───────────────────────────────────────────────
// FACT_PLACEHOLDER sirve en los archivos de dreams (los lee el operador en /dreams): dice
// qué se quitó. Pero en el DIGEST que recibe el agente (SuperCines, oct-2026: «remite a
// [dato: tomarlo de la fuente oficial] o al correo de gerencia») el agente podía copiarlo
// tal cual al cliente. Dos cortes:
//  - FACT_MARKER_RE: el verificador de salida (response-guard.ts) bloquea toda respuesta
//    que lo traiga, o una variante cercana;
//  - agentFacingFacts: el digest del agente lleva una frase natural, segura si se repite.

/**
 * Marcador o variante cercana: «[dato: …]», «[ Datos : … ]» o «[dato]» suelto. NO dispara
 * con lo que un negocio escribe de verdad: un link markdown «[datos](url)», una etiqueta de
 * formulario «[Datos]: nombre, cédula» ni la frase «tomarlo de la fuente oficial» fuera de
 * corchetes (falsos positivos: bloqueaban respuestas legítimas).
 */
export const FACT_MARKER_RE = /\[\s*datos?\s*(?::|\](?!\s*[(:]))/i;

/** Tras una preposición («remite a …», «consulta en …»): el lugar al que se deriva. */
export const AGENT_FACT_PHRASE = "los canales oficiales";
/**
 * Frase LEGADA: la versión anterior la ponía en lugar de un marcador sin preposición y dejaba
 * reglas mutiladas («atiende emergencias el dato oficial»). Ya no se escribe; solo se
 * reconoce en la entrada de la consolidación (restoreLegacyFactPhrase).
 */
export const AGENT_FACT_STANDALONE = "el dato oficial";

// Marcador con contenido (el modelo copia variantes al consolidar, a veces largas: «[dato:
// tomarlo de la fuente oficial del banco, sección de tasas …]»). Contenido acotado a
// MARKER_MAX_CONTENT sin «]» ni salto de línea: clase negada y cuantificador acotado, sin
// anidamiento → lineal por inicio de marcador; las líneas ya vienen acotadas (MAX_LINE_CHARS).
// La forma sin contenido («[dato]») no cuenta si sigue «(» o «:» (link markdown, etiqueta).
const MARKER_MAX_CONTENT = 1000;
const MARKER = String.raw`\[\s*datos?\s*(?::[^\]\n]{0,${MARKER_MAX_CONTENT}}\]|\](?!\s*[(:]))`;
const MARKER_RUN = new RegExp(`${MARKER}(?:\\s{0,3}(?:[–—-]|a|y|o|hasta|,)\\s{0,3}${MARKER})+`, "gi");
const MARKER_ANY = new RegExp(MARKER, "gi");

/** Tipo de un marcador por su contenido (el canónico o una variante que copió el modelo). */
export function markerKind(marker: string): "schedule" | "availability" | "fact" {
  if (/disponibilidad/i.test(marker)) return "availability";
  if (/horario/i.test(marker)) return "schedule";
  return "fact";
}

/** Marcador canónico de su tipo (protocolSafeRule normaliza variantes sin perder el tipo). */
export function canonicalMarker(marker: string): string {
  const k = markerKind(marker);
  return k === "schedule" ? SCHEDULE_PLACEHOLDER : k === "availability" ? AVAILABILITY_PLACEHOLDER : FACT_PLACEHOLDER;
}

/** Frase natural de un horario quitado: «lunes a viernes en el horario oficial». */
export const AGENT_SCHEDULE_PHRASE = "en el horario oficial";
/** Frase natural de una disponibilidad quitada: «atiende emergencias según el horario oficial». */
export const AGENT_AVAILABILITY_PHRASE = "según el horario oficial";

// Horario o disponibilidad con lo que lo introduce: «de [h]», «desde [h]», «es [h]», «horario
// de [h]» o suelto. Un horario NUNCA se reescribe como canal («de los canales oficiales»).
const TIME_SLOT = new RegExp(
  String.raw`(?:\b(de|desde|entre|hasta|a\s{1,3}partir\s{1,3}de|a|en|durante)(?:\s{1,3}las?)?\s{1,3}|\b(es|son|ser[aá]n?)\s{1,3}(?:de\s{1,3})?|\b(horarios?)\s{1,3}(?:de\s{1,3}|es\s{1,3}|:\s{0,3})?)?(` +
    MARKER +
    ")",
  "gi",
);

function keepCase(original: string, phrase: string): string {
  return original && original[0] !== original[0].toLowerCase() ? phrase[0].toUpperCase() + phrase.slice(1) : phrase;
}

function timeSlotPhrase(m: string, prep: string | undefined, cop: string | undefined, noun: string | undefined, marker: string): string {
  const kind = markerKind(marker);
  if (kind === "fact") return m;
  if (noun) return `${noun} oficial`;
  const phrase = kind === "availability" ? AGENT_AVAILABILITY_PHRASE : AGENT_SCHEDULE_PHRASE;
  // «El horario es [h]», «la atención es [24/7]»: la oración solo AFIRMA el dato (no hay conducta
  // que salvar; «el horario es el horario oficial» sería basura): queda el marcador genérico y la
  // cláusula se quita entera.
  if (cop) return `${cop} ${FACT_PLACEHOLDER}`;
  return keepCase(prep ?? "", phrase);
}
// «remite al correo [dato…]», «escribe al número de WhatsApp [dato…]»: el sustantivo del canal
// (con artículo opcional) entre la preposición y el marcador también se reemplaza por la frase
// natural («remite a los canales oficiales»); sin él la cláusula entera se quitaba.
const CHANNEL_NOUN =
  "(?:(?:el|la|los|las|su|sus|nuestro|nuestra)\\s{1,3})?(?:correo(?:\\s{1,3}electr[oó]nico)?|e-?mail|tel[eé]fono|n[uú]mero(?:\\s{1,3}de\\s{1,3}(?:tel[eé]fono|contacto|whatsapp))?|whatsapp|enlace|link|p[aá]gina(?:\\s{1,3}web)?|sitio(?:\\s{1,3}web)?|web|direcci[oó]n)\\s{1,3}";
const PREP_MARKER = new RegExp(`\\b(a|al|en|de|del|por|con|hacia)\\s{1,3}(?:${CHANNEL_NOUN})?${MARKER}`, "gi");
const HAS_MARKER = new RegExp(MARKER, "i");
const HEADING_PREFIX = /^\s*#{1,6}\s+/;
const PREP_FOLD: Record<string, string> = { al: "a", del: "de" };

/** Primera letra en mayúscula (la cláusula que queda pasó a ser el inicio de la oración). */
function capitalizeFirst(s: string): string {
  return s.replace(/^(\s*)(\p{Ll})/u, (_m, sp: string, c: string) => sp + c.toUpperCase());
}

/**
 * Una línea que va al agente con marcadores: los que siguen a una preposición tienen frase
 * natural («remite a los canales oficiales»); cualquier otro («atiende emergencias [dato…]»,
 * «Cashea desde [dato…]») NO: «el dato oficial» en esa posición era una regla mutilada que el
 * agente podía copiar al cliente (Veterinaria, KIA, oct-2026). Esa oración o cláusula (hasta
 * «.», «!», «?» o «;») se quita entera, y lo que queda nunca termina colgando en «;», «:» o
 * «,». Una línea que se queda sin nada desaparece.
 */
function agentFacingLine(line: string): string | null {
  const s = line
    // Una serie («[h] a [h]») vale como un solo dato; si es de horario, sigue siendo horario.
    .replace(MARKER_RUN, (run: string) => {
      const kinds = [...run.matchAll(MARKER_ANY)].map((m) => markerKind(m[0]));
      if (kinds.every((k) => k === "availability")) return AVAILABILITY_PLACEHOLDER;
      return kinds.some((k) => k !== "fact") ? SCHEDULE_PLACEHOLDER : FACT_PLACEHOLDER;
    })
    .replace(TIME_SLOT, timeSlotPhrase)
    .replace(PREP_MARKER, (_m, prep: string) => {
      const p = PREP_FOLD[prep.toLowerCase()] ?? prep;
      return `${prep[0] === prep[0].toUpperCase() ? p[0].toUpperCase() + p.slice(1) : p} ${AGENT_FACT_PHRASE}`;
    });
  if (!HAS_MARKER.test(s)) return s;
  const prefix = s.match(HEADING_PREFIX)?.[0] ?? s.match(BULLET)?.[1] ?? "";
  const clauses = splitSentences(s.slice(prefix.length));
  const kept: string[] = [];
  let firstDropped = false;
  let prevDropped = false;
  clauses.forEach((c) => {
    // La que remite a una cláusula quitada («Esto acelera…») se va con ella.
    prevDropped = HAS_MARKER.test(c) || (prevDropped && isAnaphoric(c));
    if (prevDropped) {
      if (kept.length === 0) firstDropped = true;
    } else if (c.trim()) kept.push(c);
  });
  if (kept.length === 0) return null;
  kept[kept.length - 1] = closeDangling(kept[kept.length - 1]);
  const body = kept.join(" ");
  return prefix + (firstDropped ? capitalizeFirst(body) : body);
}

/**
 * Red de seguridad del texto que va al AGENTE (digest y resumen archivado; los datos ya se
 * cortaron en la ENTRADA de la consolidación, consolidationInput): si el modelo copió el
 * marcador, «remite a [dato…]» → «remite a los canales oficiales» y la cláusula con un
 * marcador sin preposición se quita limpia (agentFacingLine). Si el agente repite el texto
 * al cliente, no expone nada interno ni frases mutiladas. Idempotente; sin marcadores
 * devuelve el mismo texto.
 */
export function agentFacingFacts(text: string): string {
  const s = String(text ?? "");
  if (!FACT_MARKER_RE.test(s)) return s;
  const out: string[] = [];
  for (const line of s.split("\n")) {
    const l = agentFacingLine(capLine(line));
    if (l !== null) out.push(l);
  }
  return out.join("\n").replace(/tomarlo de la fuente oficial/gi, "tomarlo de las fuentes oficiales");
}

/**
 * «el dato oficial» (AGENT_FACT_STANDALONE) solo lo escribía la versión anterior de
 * agentFacingFacts en lugar del marcador («atiende emergencias el dato oficial»): en la
 * ENTRADA de la consolidación vuelve a ser el marcador, para que el modelo reescriba la regla
 * en vez de copiar el fragmento.
 */
export function restoreLegacyFactPhrase(text: string): string {
  return String(text ?? "").replace(/\bel dato oficial\b/gi, FACT_PLACEHOLDER);
}


// ─── Salida de la consolidación: formas de dato de ALTO RIESGO (oct-2026) ────
// La salida del consolidador ya no pasa por neutralizeBusinessFacts (mutilaba reglas de
// conducta válidas: KIA, Veterinaria), así que una salida manipulada (prompt injection en el
// texto de un dream) podía reintroducir en el contexto PRIVILEGIADO del agente un correo, un
// enlace, un teléfono o un monto. Acá solo se DETECTAN esas cuatro formas, con los mismos
// patrones acotados de arriba (TOKEN_PATTERNS, línea acotada a MAX_LINE_CHARS: nada
// cuadrático). Las fechas, horas, «24/7» y rangos se consumen ANTES como neutros (mismo orden
// que el corte), así una fecha ISO no cuenta como teléfono. Nunca se reescribe la línea: quien
// llama saca la viñeta ENTERA (removeDataShapeLines), sin cirugía de cláusulas.

/** Prefijo de la nota al operador con la viñeta que salió del digest por traer un dato. */
export const DATA_SHAPE_NOTE_PREFIX = "Revisar (dato sin fuente en un aprendizaje):";

// Separador neutro: no es dígito, espacio ni símbolo de moneda; no une números vecinos.
const NEUTRAL = "¤";

/** Formas de alto riesgo (correo, URL/dominio, teléfono ≥7 dígitos, monto) de una línea. */
export function highRiskDataShapes(line: string): DataShapeKind[] {
  let text = capLine(String(line ?? ""));
  const found = new Set<DataShapeKind>();
  for (const p of TOKEN_PATTERNS) {
    text = text.replace(p.re, (m: string) => {
      if (p.valid && !p.valid(m)) return m;
      if (p.kind) found.add(p.kind);
      return NEUTRAL;
    });
  }
  return [...found];
}

/**
 * Saca de un texto (digest o resumen archivado) cada renglón que trae una forma de alto
 * riesgo, ENTERO. `removed` lleva el cuerpo de cada uno (sin la viñeta) para la nota al
 * operador; un encabezado que queda sin contenido debajo también se quita. Sin coincidencias
 * devuelve el mismo texto.
 */
export function removeDataShapeLines(input: string): { text: string; removed: string[] } {
  const src = String(input ?? "");
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of src.split("\n")) {
    // Una línea más larga que lo que se escanea (MAX_LINE_CHARS) no se puede garantizar libre de
    // datos: lo que quedara después del corte pasaría sin revisar. Una regla de conducta nunca es
    // tan larga, así que se trata como riesgosa y sale entera (decidir sobre lo mismo que se guarda).
    if (line.trim() && (line.length > MAX_LINE_CHARS || highRiskDataShapes(line).length > 0)) {
      const prefix = line.match(BULLET)?.[1] ?? line.match(HEADING_PREFIX)?.[0] ?? "";
      removed.push(capLine(line.slice(prefix.length).trim()));
      continue;
    }
    kept.push(line);
  }
  if (removed.length === 0) return { text: src, removed };
  // Encabezados sin contenido debajo (hasta el próximo encabezado o el final).
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    if (HEADING.test(kept[i])) {
      let j = i + 1;
      while (j < kept.length && !kept[j].trim()) j++;
      if (j >= kept.length || HEADING.test(kept[j])) continue;
    }
    out.push(kept[i]);
  }
  return { text: out.join("\n").trim(), removed };
}
