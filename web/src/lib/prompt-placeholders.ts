// Inversa de la sustitución de placeholders de lib/agent-prompt.ts (substitutePlaceholders).
//
// POR QUÉ: el system del agente VIVO viene con {{OPERATOR_NAME}}, {{MASTER_PATH}},
// {{LEADS_PATH}}, {{MEMORY_STORE_MASTER}} y {{MEMORY_STORE_LEADS}} ya sustituidos.
// Importarlo tal cual a runtime_config.SYSTEM_PROMPT dejaría los valores literales:
// al renombrar el operador o un store, el prompt quedaría desfasado. Al importar se
// RE-placeholderizan los valores conocidos.
//
// CUIDADOS:
//  · UNA sola pasada con alternancia ordenada de más largo a más corto: los valores que
//    contienen a otros (`/mnt/memory/<store>` contiene el nombre del store) ganan, y un
//    placeholder ya insertado nunca se vuelve a reemplazar por dentro.
//  · Los valores se buscan como TOKENS completos (no dentro de otra palabra).
//  · Valores AMBIGUOS no se tocan y se informan: demasiado cortos (<4), palabras
//    comunes (incluidos los defaults «el operador» / «master» / «leads» con que se
//    sustituye cuando falta el valor) o compartidos entre dos placeholders.
//  · Las rutas `/mnt/memory/<store>` son inequívocas (el prefijo lo garantiza) salvo que
//    los dos stores se llamen igual.
import type { PlaceholderValues } from "./agent-prompt.ts";

export type PlaceholderReplacement = { placeholder: string; value: string; count: number };
export type PlaceholderAmbiguity = {
  placeholder: string;
  value: string;
  /** Apariciones en el texto que NO se reemplazaron. */
  count: number;
  reason: "short" | "common_word" | "shared_value";
};
export type PlaceholderizeResult = {
  text: string;
  replaced: PlaceholderReplacement[];
  ambiguous: PlaceholderAmbiguity[];
};

const MIN_NAME_LENGTH = 4;
/** Palabras que, como valor de un placeholder, casi seguro aparecen en el texto por otra razón. */
const COMMON_WORDS = new Set(
  ["el operador", "operador", "master", "leads", "agente", "asesor", "equipo", "tienda", "empresa", "cliente", "clientes", "ventas"]
);

type Candidate = { placeholder: string; value: string; kind: "path" | "name" };

const WORD = String.raw`[\p{L}\p{N}_-]`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alt = (c: Candidate) =>
  c.kind === "path" ? `${escapeRe(c.value)}(?!${WORD})` : `(?<!${WORD})${escapeRe(c.value)}(?!${WORD})`;

function countOccurrences(text: string, c: Candidate): number {
  return text.match(new RegExp(alt(c), "gu"))?.length ?? 0;
}

export function placeholderize(text: string, values: PlaceholderValues): PlaceholderizeResult {
  const all = ([
    { placeholder: "{{MASTER_PATH}}", value: `/mnt/memory/${values.masterStoreName}`, kind: "path" },
    { placeholder: "{{LEADS_PATH}}", value: `/mnt/memory/${values.leadsStoreName}`, kind: "path" },
    { placeholder: "{{MEMORY_STORE_MASTER}}", value: values.masterStoreName, kind: "name" },
    { placeholder: "{{MEMORY_STORE_LEADS}}", value: values.leadsStoreName, kind: "name" },
    { placeholder: "{{OPERATOR_NAME}}", value: values.operatorName, kind: "name" },
  ] as Candidate[]).filter((c) => c.value.trim() !== "" && !c.value.endsWith("/"));

  const sharing = (c: Candidate) => all.some((o) => o !== c && o.value === c.value);
  const safe: Candidate[] = [];
  const unsafe: { c: Candidate; reason: PlaceholderAmbiguity["reason"] }[] = [];
  const ambiguous: PlaceholderAmbiguity[] = [];
  for (const c of all) {
    let reason: PlaceholderAmbiguity["reason"] | null = null;
    if (sharing(c)) reason = "shared_value";
    else if (c.kind === "name" && [...c.value].length < MIN_NAME_LENGTH) reason = "short";
    else if (c.kind === "name" && COMMON_WORDS.has(c.value.trim().toLowerCase())) reason = "common_word";
    if (reason === null) safe.push(c);
    else unsafe.push({ c, reason });
  }

  safe.sort((a, b) => b.value.length - a.value.length);
  const counts = new Map<string, number>();
  let out = text;
  if (safe.length > 0) {
    const re = new RegExp(safe.map((c) => `(${alt(c)})`).join("|"), "gu");
    out = text.replace(re, (...args: unknown[]) => {
      const idx = (args.slice(1, 1 + safe.length) as (string | undefined)[]).findIndex((g) => g !== undefined);
      const c = safe[idx];
      counts.set(c.placeholder, (counts.get(c.placeholder) ?? 0) + 1);
      return c.placeholder;
    });
  }
  // Las ambiguas se cuentan sobre el texto YA reemplazado: no se informa como ambiguo un
  // «master» que en realidad estaba dentro de una ruta /mnt/memory/master ya resuelta.
  for (const { c, reason } of unsafe) {
    const count = countOccurrences(out, c);
    if (count > 0) ambiguous.push({ placeholder: c.placeholder, value: c.value, count, reason });
  }
  const replaced = safe
    .filter((c) => counts.has(c.placeholder))
    .map((c) => ({ placeholder: c.placeholder, value: c.value, count: counts.get(c.placeholder)! }));
  return { text: out, replaced, ambiguous };
}
