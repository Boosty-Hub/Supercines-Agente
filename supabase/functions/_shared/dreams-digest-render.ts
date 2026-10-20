// _shared/dreams-digest-render.ts
// DREAMS_DIGEST (lo que el agente recibe en cada sesión) se ARMA DE FORMA DETERMINÍSTICA, sin
// modelo, a partir de los dreams ACTIVOS y del resumen archivado (DREAMS_ARCHIVE_DIGEST).
//
// Por qué (producción, 4 clientes, 4 rondas de arreglos en oct-2026): pedirle al modelo que
// REESCRIBA todas las reglas activas en un digest es con pérdida e indeterminista por
// naturaleza — reglas que desaparecían, matices perdidos, texto mutilado — por más chequeos de
// pérdida, reintentos y alertas que se le pusieran alrededor. Ahora:
//   · cada dream activo = UNA viñeta con su propio texto (sin frontmatter, sin el título y sin
//     la «**Evidencia:**»), en secciones por severidad. Mismo set de dreams → mismo digest,
//     byte por byte; borrar un dream saca su viñeta y nada más;
//   · el resumen archivado (ya escrito por el modelo al archivar) va al final, viñeta por
//     viñeta, bajo «## Aprendizajes consolidados»;
//   · el tope DREAMS_DIGEST_MAX_WORDS NUNCA recorta reglas: si el digest no entra, se archivan
//     los dreams activos MÁS VIEJOS (planArchive; el archivado sí usa el modelo, con su chequeo
//     de pérdida) y se vuelve a armar. Si aun así no entra (el resumen archivado solo ya es
//     muy grande), se guarda COMPLETO y se avisa (digestOverCapAlert). Un digest más largo
//     cuesta palabras; una regla perdida en silencio cuesta respuestas equivocadas.
//
// Cada regla (de un dream activo o del resumen archivado) pasa, en este orden, por:
//   1) protocolSafeRule: marcas del protocolo o etiquetas («<respuesta>», «<turno …>»,
//      «[CONTEXTO]») fuera; cualquier «<»/«>» que quede, escapado (como untrusted.ts). Un
//      dream es texto derivado de conversaciones de leads: no puede plantar marcas en el
//      contexto privilegiado del agente;
//   2) el MISMO corte de datos de la entrada de la consolidación (neutralizeInputText): los
//      dreams escritos ANTES de que existiera el corte (SuperCines: «la sede Playa Mar está
//      cerrada por afectación sísmica…», «remite al correo atencion@…») ya no llegan tal cual;
//   3) la red del marcador (agentFacingFacts): «remite a(l correo) [dato…]» → «remite a los
//      canales oficiales»; una cláusula con un marcador sin preposición se quita limpia, sin
//      dejar nada colgando. Si la regla queda vacía, sale y va a las notas del operador
//      («revisar: quedó vacío tras quitar datos»);
//   4) red de salida (también la aplica dreamsDigestBlock al inyectar): una viñeta con un
//      correo, enlace, teléfono o monto —o una regla original más larga que MAX_LINE_CHARS— no
//      entra al digest: va a las notas del operador (dataShapeNote).

import { agentFacingFacts, FACT_PLACEHOLDER, MAX_LINE_CHARS, removeDataShapeLines } from "./dreams-facts.ts";
import { frontmatter } from "./dreams-generation.ts";
import { dataShapeNote, type DreamLike, neutralizeInputText, normalizeBulletLines } from "./dreams-consolidation.ts";
import { sanitizeUntrusted } from "./untrusted.ts";
import { truncateGraphemes } from "./text-safe.ts";

/**
 * Versión del armado: entra al fingerprint (dreams-digest-fingerprint.ts). Subirla al cambiar
 * cómo se arma el digest fuerza UNA reconstrucción en el próximo run.
 */
export const DIGEST_RENDER_VERSION = "render-2";

export type DreamSeverity = "err" | "adv" | "sug";

export const SECTION_HEADINGS: Readonly<Record<DreamSeverity | "archive", string>> = {
  err: "## Errores a no repetir",
  adv: "## Advertencias",
  sug: "## Refuerzos y estilo",
  archive: "## Aprendizajes consolidados",
};

const SECTION_ORDER: ReadonlyArray<DreamSeverity | "archive"> = ["err", "adv", "sug", "archive"];

const baseName = (p: string) => p.split("/").pop() ?? p;

/** Severidad: frontmatter → token del nombre de archivo → categoría → sugerencia. */
export function dreamSeverity(content: string, path: string): DreamSeverity {
  const { meta } = frontmatter(String(content ?? ""));
  const s = String(meta.severity ?? "").toLowerCase();
  if (s === "error" || s === "err") return "err";
  if (s.startsWith("adv") || s === "warning") return "adv";
  if (s.startsWith("sug") || s === "info") return "sug";
  const token = baseName(path).match(/_(err|adv|sug)_/);
  if (token) return token[1] as DreamSeverity;
  if (meta.category === "anti_pattern") return "err";
  if (meta.category === "factual_gap") return "adv";
  return "sug";
}

// Controles, invisibles y marcas bidi: no aportan nada a una regla y pueden esconder texto.
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const EVIDENCE = /\*\*\s*Evidencia\s*:?\s*\*\*/i;
const HEADING = /^\s*#{1,6}\s/;
const BULLET_PREFIX = /^\s*(?:[-*•–—]|\d+[.)])\s+/;

function oneLine(text: string): string {
  return text.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
}

function titleOf(meta: Record<string, string>, body: string): string {
  if (meta.title) {
    try {
      const t = JSON.parse(meta.title);
      if (typeof t === "string") return oneLine(t);
    } catch {
      return oneLine(meta.title);
    }
  }
  return oneLine(body.match(/^\s*#{1,6}\s+(.+)$/m)?.[1] ?? "");
}

/**
 * El texto de la regla de un dream, en UN renglón: el cuerpo sin frontmatter, sin encabezados
 * (el título) y sin la parte «**Evidencia:**». Varios renglones se unen (una lista interna se
 * une con «; »). Sin cuerpo, el título. "" si no hay nada.
 */
export function dreamRuleText(content: string): string {
  const { meta, body } = frontmatter(String(content ?? ""));
  const ev = body.search(EVIDENCE);
  const main = ev >= 0 ? body.slice(0, ev) : body;
  let out = "";
  for (const raw of main.split("\n")) {
    if (HEADING.test(raw)) continue;
    const isItem = BULLET_PREFIX.test(raw);
    const line = oneLine(raw.replace(BULLET_PREFIX, ""));
    if (!line) continue;
    if (!out) out = line;
    else out += (isItem && !/[.!?;:]$/.test(out) ? "; " : " ") + line;
  }
  return out || titleOf(meta, body);
}

/** Clave de deduplicación: misma regla salvo mayúsculas, espacios o el punto final. */
function dedupeKey(rule: string): string {
  return rule.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").replace(/[\s.;]+$/, "").trim();
}

export const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

// Etiqueta ya escapada por sanitizeUntrusted («&lt;respuesta&gt;», «&lt;/turno&gt;»,
// «&lt;turno rol="agente"&gt;»): acotada y sin «&» adentro → lineal.
const ESCAPED_TAG = /&lt;\s{0,3}\/?\s{0,3}[A-Za-z_][^&\n]{0,200}?&gt;/g;
// Encabezados de bloque del contexto del agente («[CONTEXTO]», «[HISTORIAL]», «[MENSAJES NUEVOS]»):
// en mayúsculas, sin «:» (el marcador «[dato: …]» va en minúsculas y no coincide).

/**
 * Una regla sin marcas del protocolo: NFKC + paréntesis angulares alternativos → «<»/«>» y
 * escape de «<»/«>» (sanitizeUntrusted), se quitan las etiquetas y los encabezados de bloque,
 * y lo que quede de «<»/«>» queda escapado. En un renglón.
 */
export function protocolSafeRule(rule: string): string {
  // 1) Forma final de espacios ANTES de filtrar: colapsar después podía armar una marca nueva.
  let s = oneLine(sanitizeUntrusted(rule)).replace(/\s+([.,;:!?])/g, "$1");
  // 2) Etiquetas escapadas fuera hasta que no cambie nada. Cada pasada que cambia acorta la
  //    cadena, así que el tope por largo nunca corta antes de tiempo.
  for (let i = 0; i <= s.length; i++) {
    const next = s.replace(ESCAPED_TAG, " ");
    if (next === s) break;
    s = next;
  }
  // 3) Corchetes: imposible de rearmar. Todo «[»/«]» pasa a paréntesis salvo el marcador de dato
  //    («[dato: …]», que se normaliza al canónico y luego reescribe agentFacingFacts). Así
  //    ninguna regla puede imitar un encabezado del [CONTEXTO] («[CONTEXTO]», «[SYSTEM-PROMPT]»…).
  //    Antes, un encabezado sin minúsculas («[CONTEXTO]», «[ INSTRUCCIONES: ]») se quita entero
  //    (una pasada basta: lo que sobre de un anidado termina como paréntesis, nunca como corchete).
  s = s.replace(UPPER_BRACKET, " ");
  const parts: string[] = [];
  let last = 0;
  for (const m of s.matchAll(MARKER_FULL)) {
    parts.push(s.slice(last, m.index).replace(/\[/g, "(").replace(/\]/g, ")"), FACT_PLACEHOLDER);
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(s.slice(last).replace(/\[/g, "(").replace(/\]/g, ")"));
  s = parts.join("").replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  // 4) Falla cerrado: si aún queda algo con forma de etiqueta, la regla no entra.
  if (new RegExp(ESCAPED_TAG.source).test(s)) return "";
  return s;
}

/** Corchete sin minúsculas (imita un encabezado del [CONTEXTO]), acotado. */
const UPPER_BRACKET = /\[[^\[\]\na-záéíóúñü]{1,64}\]:?/g;

/** Marcador de dato completo (`[dato: …]`, `[datos: …]`, cualquier caja), acotado. */
const MARKER_FULL = /\[\s{0,3}datos?\s{0,3}:[^\[\]\n]{0,1000}\]/gi;

const NOTE_RULE_MAX_CHARS = 500;

/** Nota al operador: la regla se quedó sin nada tras quitar sus datos (no entra al digest). */
function emptyRuleNote(source: string, rule: string): string {
  return dataShapeNote(`«${source}» — revisar: quedó vacío tras quitar datos: ${truncateGraphemes(rule, NOTE_RULE_MAX_CHARS, { ellipsis: "…" })}`);
}

type Parsed = { path: string; base: string; severity: DreamSeverity; rule: string; date: string; occurrences: number };

function parseDream(d: DreamLike): Parsed {
  const { meta } = frontmatter(String(d.content ?? ""));
  const base = baseName(d.path);
  const occ = parseInt(meta.occurrences ?? "", 10);
  return {
    path: d.path,
    base,
    severity: dreamSeverity(d.content, d.path),
    rule: dreamRuleText(d.content),
    // El nombre de archivo arranca con la fecha ISO (y un refresco lo renueva).
    date: base.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "",
    occurrences: Number.isFinite(occ) && occ >= 1 ? occ : 1,
  };
}

/** Más reciente primero; empate → más ocurrencias; después por nombre (orden total, estable). */
function byPriority(a: Parsed, b: Parsed): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
  if (a.base !== b.base) return a.base < b.base ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Viñetas del resumen archivado (el texto suelto también cuenta; los encabezados no). */
function archiveRules(archived: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeBulletLines(String(archived ?? "")).split("\n")) {
    if (HEADING.test(raw)) continue;
    const line = oneLine(raw.replace(BULLET_PREFIX, ""));
    if (line) out.push(line);
  }
  return out;
}

export type RenderedDigest = {
  /** DREAMS_DIGEST: Markdown, una viñeta por renglón. "" si no hay reglas. */
  text: string;
  words: number;
  /** Viñetas que NO entraron (dato de alto riesgo, o vacías tras quitar datos): notas para el operador. */
  notes: string[];
  /** Viñetas en el digest. */
  bullets: number;
};

/**
 * Arma el digest. Puro y determinístico: el orden de `dreams` no importa (se ordena por
 * prioridad) y la misma entrada da el mismo texto, byte por byte.
 */
export function renderDigest(dreams: ReadonlyArray<DreamLike>, archived: string): RenderedDigest {
  const sections: Record<DreamSeverity | "archive", string[]> = { err: [], adv: [], sug: [], archive: [] };
  const notes: string[] = [];
  const seen = new Set<string>();
  const add = (section: DreamSeverity | "archive", rule: string, source: string) => {
    if (!rule) return;
    // Más largo que lo que escanean las redes: no se puede garantizar libre de datos.
    if (rule.length + 2 > MAX_LINE_CHARS) {
      notes.push(dataShapeNote(truncateGraphemes(rule, MAX_LINE_CHARS)));
      return;
    }
    const safe = protocolSafeRule(rule);
    // Corte de datos de la entrada + red del marcador (ver el encabezado del archivo).
    const line = agentFacingFacts(neutralizeInputText(`- ${safe}`)).trim();
    if (!line || line === "-" || !line.replace(BULLET_PREFIX, "").trim()) {
      notes.push(emptyRuleNote(source, safe || rule));
      return;
    }
    const shaped = removeDataShapeLines(line);
    if (shaped.removed.length > 0) {
      notes.push(...shaped.removed.map(dataShapeNote));
      return;
    }
    const key = dedupeKey(line.replace(BULLET_PREFIX, ""));
    if (!key || seen.has(key)) return;
    seen.add(key);
    sections[section].push(line);
  };
  const parsed = dreams.map(parseDream).sort(byPriority);
  for (const sev of ["err", "adv", "sug"] as const) {
    for (const p of parsed) if (p.severity === sev) add(sev, p.rule, p.base);
  }
  for (const rule of archiveRules(archived)) add("archive", rule, "resumen archivado");
  const text = SECTION_ORDER
    .filter((s) => sections[s].length > 0)
    .map((s) => `${SECTION_HEADINGS[s]}\n${sections[s].join("\n")}`)
    .join("\n\n");
  return {
    text,
    words: wordCount(text),
    notes,
    bullets: SECTION_ORDER.reduce((n, s) => n + sections[s].length, 0),
  };
}

/** Ordena del más viejo al más nuevo por nombre de archivo (arranca con la fecha). */
export function oldestFirst<D extends DreamLike>(dreams: ReadonlyArray<D>): D[] {
  return [...dreams].sort((a, b) => {
    const x = baseName(a.path);
    const y = baseName(b.path);
    if (x !== y) return x < y ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

export type ArchivePlan<D> = {
  /** Dreams a archivar, los más viejos primero (vacío = no hace falta archivar). */
  toArchive: D[];
  /** Tope de palabras del resumen archivado NUEVO (consolidación «archive»). */
  archiveMaxWords: number;
};

/**
 * Qué archivar en esta corrida. Dos motivos, se toma el mayor:
 *  - exceso sobre DREAMS_MAX_ACTIVE (como siempre);
 *  - el digest pasa el tope de palabras: los más viejos que hagan falta para que lo activo
 *    entre en `maxWords − reserva`, con la reserva = lo que ya ocupa el resumen archivado (al
 *    menos un tercio del tope) para la esencia de lo que se archiva. Si ni archivando TODO
 *    entra (el resumen archivado solo ya ocupa el tope), archivar no lo arregla y no se
 *    archiva nada por este motivo (el llamador avisa con digestOverCapAlert).
 * Por corrida como mucho `batch` (archivar son 2 llamadas HTTP por archivo); las siguientes
 * corridas siguen drenando (canSkipDigestRebuild no omite mientras quede algo por archivar).
 */
export function planArchive<D extends DreamLike>(opts: {
  dreams: ReadonlyArray<D>;
  archived: string;
  maxWords: number;
  maxActive: number;
  batch: number;
}): ArchivePlan<D> {
  const dreams = oldestFirst(opts.dreams);
  const { maxWords } = opts;
  const activeWords = (k: number) => renderDigest(dreams.slice(k), "").words;
  const byCount = Math.max(0, dreams.length - opts.maxActive);
  let byWords = 0;
  if (renderDigest(dreams, opts.archived).words > maxWords) {
    const reserve = Math.max(renderDigest([], opts.archived).words, Math.floor(maxWords / 3));
    const limit = maxWords - reserve;
    if (limit >= 0) {
      // Mínimo k con lo activo dentro del límite. Quitar un dream nunca agrega palabras (a lo
      // sumo deja ver un duplicado idéntico, o se va un encabezado): búsqueda binaria.
      let lo = 0;
      let hi = dreams.length; // activeWords(n) = 0 ≤ limit
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (activeWords(mid) <= limit) hi = mid;
        else lo = mid + 1;
      }
      byWords = lo;
    }
  }
  const k = Math.min(Math.max(byCount, byWords), Math.max(0, opts.batch), dreams.length);
  const toArchive = dreams.slice(0, k);
  return {
    toArchive,
    archiveMaxWords: Math.max(Math.floor(maxWords / 3), maxWords - activeWords(k)),
  };
}

/**
 * Alerta (`dream_error`) cuando el digest armado pasa el tope y archivar no lo resolvió: se
 * guardó COMPLETO (nunca se recortan reglas). La salida es subir DREAMS_DIGEST_MAX_WORDS o
 * depurar dreams en /dreams.
 */
export function digestOverCapAlert(info: { words: number; maxWords: number; activeCount: number; archiveWords: number }) {
  return {
    kind: "dream_error" as const,
    severity: "warning" as const,
    title: `Dreams: el digest del agente tiene ${info.words} palabras (tope ${info.maxWords})`,
    description:
      `El digest se guardó COMPLETO con ${info.words} palabras, por encima del tope de ${info.maxWords}: ` +
      `ninguna regla se recorta. ${info.activeCount} aprendizajes activos y ${info.archiveWords} palabras de aprendizajes consolidados (archivados). ` +
      "Cada palabra se paga en cada respuesta del agente: sube DREAMS_DIGEST_MAX_WORDS o depura en /dreams los aprendizajes redundantes.",
    metadata: {
      reason: "digest_over_cap",
      words: info.words,
      max_words: info.maxWords,
      active: info.activeCount,
      archive_words: info.archiveWords,
    },
  };
}
