// _shared/text-safe.ts
// Texto seguro para viajar a un prompt (Anthropic) o a Kommo.
//
// COPIA ESPEJO en web/src/lib/text-safe.ts: deben ser byte a byte idénticos
// (lo fuerza text-safe.test.ts). Si cambias uno, cambia el otro.
//
// Por qué existe: un `string.slice(0, n)` corta por UNIDADES UTF-16 y puede caer
// entre las dos mitades de un emoji (par subrogado), dejando un surrogate alto
// SUELTO. Un string con un surrogate suelto no es Unicode válido: la API de
// Anthropic rechaza el request ENTERO con `400 no low surrogate in string` (esto
// ya tumbó la clasificación en producción en otro proyecto). Los surrogates
// sueltos también pueden llegar rotos desde el origen (Kommo, webhooks), y
// Postgres (jsonb) los rechaza al guardar.
//
// DECISIÓN DE UNIDAD: el LÍMITE `max` se mide en unidades UTF-16 (`string.length`)
// y el CORTE se hace en frontera de GRAFEMA (Intl.Segmenter).
//  - Límite en code units: los topes que respetamos (280 de la respuesta pública,
//    8 KB de tool, 2000 de la nota, tokens del modelo) son techos duros. Como
//    code units >= code points >= grafemas, un resultado con length <= max NUNCA
//    excede el máximo contado de cualquiera de las tres formas. Medir en grafemas
//    permitiría pasarse del tope real (una familia ZWJ es 1 grafema y 11 code units).
//  - Corte en grafema: partir por code point deja emojis compuestos a medias
//    (bandera con una sola letra regional, familia sin un miembro, tono de piel
//    sin base, combinantes sin su letra) que se ven rotos aunque sean UTF-16 válido.
// Intl.Segmenter existe en Deno (runtime de Supabase Edge) y en Node >= 16.

// Surrogate alto sin bajo detrás, o bajo sin alto delante.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Saca los surrogates UTF-16 sueltos (el resto del texto queda intacto). */
export function stripLoneSurrogates(text: string): string {
  return String(text ?? "").replace(LONE_SURROGATE, "");
}

let segmenter: Intl.Segmenter | null = null;

// Recorre los grafemas de forma perezosa; `visit` devuelve false para cortar.
// Se usa el protocolo de iterador a mano (no `for...of`) porque web/tsconfig.json
// no fija `target` y TS rechaza `for...of` sobre un Iterable con target ES5.
function eachGrapheme(text: string, visit: (segment: string) => boolean): void {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const it = segmenter.segment(text)[Symbol.iterator]();
  for (let r = it.next(); !r.done; r = it.next()) {
    if (!visit(r.value.segment)) return;
  }
}

export interface TruncateOptions {
  /** Sufijo que se agrega SOLO si hubo corte. Cuenta dentro de `max`. Default "". */
  ellipsis?: string;
  /** Si hubo corte en medio de una palabra, retrocede hasta el último espacio (si lo hay). */
  wordBoundary?: boolean;
}

/**
 * Corta `text` a `max` unidades UTF-16 como máximo (ellipsis incluido) sin partir
 * un grafema y sin dejar surrogates sueltos. Si no hace falta cortar, devuelve el
 * texto (ya sin surrogates sueltos) tal cual. Un grafema que por sí solo no cabe
 * se descarta entero. `max <= 0` devuelve "".
 */
export function truncateGraphemes(text: string, max: number, opts: TruncateOptions = {}): string {
  const clean = stripLoneSurrogates(text);
  if (!(max > 0)) return "";
  if (clean.length <= max) return clean;

  const ellipsis = opts.ellipsis ?? "";
  // Si el sufijo no cabe, se omite: el tope duro manda sobre el adorno.
  const suffix = ellipsis.length < max ? ellipsis : "";
  const budget = max - suffix.length;

  let cut = "";
  eachGrapheme(clean, (segment) => {
    if (cut.length + segment.length > budget) return false;
    cut += segment;
    return true;
  });
  if (opts.wordBoundary && !/\s/.test(clean.charAt(cut.length))) {
    const lastSpace = cut.search(/\s\S*$/);
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  }
  return `${cut.trimEnd()}${suffix}`;
}

/** Primer grafema (p. ej. iniciales de un avatar), nunca un emoji partido. */
export function firstGrapheme(text: string): string {
  let first = "";
  eachGrapheme(stripLoneSurrogates(text), (segment) => {
    first = segment;
    return false;
  });
  return first;
}
