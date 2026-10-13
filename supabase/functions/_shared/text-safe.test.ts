// _shared/text-safe.test.ts
// Deno tests de la utilidad de texto seguro (y de su espejo web/src/lib/text-safe.ts).
//
// Correr con: deno test --allow-read supabase/functions/_shared/text-safe.test.ts

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.0";
import * as shared from "./text-safe.ts";
import * as web from "../../../web/src/lib/text-safe.ts";

const HIGH = "\uD83D"; // surrogate alto solo
const LOW = "\uDE0A"; // surrogate bajo solo

const FAMILY = "👨‍👩‍👧‍👦"; // ZWJ: 4 emojis + 3 ZWJ = 11 code units, 1 grafema
const FLAG = "🇦🇷"; // 2 regional indicators = 4 code units
const SKIN = "👍🏽"; // base + modificador = 4 code units
const COMBINING = "é̂"; // e + 2 combinantes = 3 code units
const KEYCAP = "1️⃣";

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function assertTransportSafe(s: string) {
  assert(!hasLoneSurrogate(s), `surrogate suelto en ${JSON.stringify(s)}`);
  assert(s.isWellFormed(), "no es well-formed");
  assertEquals(JSON.parse(JSON.stringify(s)), s);
  assertEquals(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(s)), s);
}

for (const [name, lib] of [["shared", shared], ["web", web]] as const) {
  const { stripLoneSurrogates, truncateGraphemes, firstGrapheme } = lib;

  Deno.test(`${name}: stripLoneSurrogates quita alto solo, bajo solo, en medio y al final`, () => {
    assertEquals(stripLoneSurrogates(`${HIGH}hola`), "hola");
    assertEquals(stripLoneSurrogates(`${LOW}hola`), "hola");
    assertEquals(stripLoneSurrogates(`ho${HIGH}la`), "hola");
    assertEquals(stripLoneSurrogates(`ho${LOW}la`), "hola");
    assertEquals(stripLoneSurrogates(`hola${HIGH}`), "hola");
    assertEquals(stripLoneSurrogates(`hola${LOW}`), "hola");
    assertEquals(stripLoneSurrogates(`${HIGH}${HIGH}${LOW}`), `${HIGH}${LOW}`); // el par válido sobrevive
    assertEquals(stripLoneSurrogates(`${LOW}${HIGH}`), ""); // orden invertido: ambos sueltos
  });

  Deno.test(`${name}: stripLoneSurrogates conserva emojis válidos y es no-op en texto limpio`, () => {
    const ok = `hola 😊 ${FAMILY} ${FLAG} ${SKIN} ${COMBINING} ${KEYCAP} ñ`;
    assertEquals(stripLoneSurrogates(ok), ok);
    assertEquals(stripLoneSurrogates(""), "");
    assertEquals(stripLoneSurrogates(null as unknown as string), "");
    assertEquals(stripLoneSurrogates(undefined as unknown as string), "");
  });

  Deno.test(`${name}: truncateGraphemes no toca texto que cabe`, () => {
    assertEquals(truncateGraphemes("hola", 10), "hola");
    assertEquals(truncateGraphemes("hola", 4), "hola");
    assertEquals(truncateGraphemes("hola", 4, { ellipsis: "…" }), "hola");
    assertEquals(truncateGraphemes(`ho${HIGH}la`, 10), "hola"); // igual limpia
  });

  Deno.test(`${name}: truncateGraphemes nunca parte un emoji compuesto`, () => {
    const casos: Array<[string, string]> = [
      ["familia ZWJ", FAMILY],
      ["bandera", FLAG],
      ["tono de piel", SKIN],
      ["combinantes", COMBINING],
      ["keycap", KEYCAP],
      ["emoji simple", "😊"],
    ];
    for (const [nombre, g] of casos) {
      const texto = `ab${g}cd`;
      for (let max = 0; max <= texto.length + 1; max++) {
        const out = truncateGraphemes(texto, max);
        assertTransportSafe(out);
        assert(out.length <= max, `${nombre} max=${max} -> length ${out.length}`);
        // El corte cae en una frontera de grafema del original: nunca a medias.
        assert(texto.startsWith(out), `${nombre} max=${max}: no es prefijo`);
        const fronteras = new Set<number>([0]);
        let pos = 0;
        for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(texto)) {
          pos += segment.length;
          fronteras.add(pos);
        }
        assert(fronteras.has(out.length), `${nombre} max=${max} cortó en medio de un grafema`);
      }
    }
  });

  Deno.test(`${name}: truncateGraphemes descarta el grafema que no cabe en vez de partirlo`, () => {
    assertEquals(truncateGraphemes(`ab${FAMILY}cd`, 5), "ab"); // la familia son 11 unidades
    assertEquals(truncateGraphemes(`ab${FAMILY}cd`, 13), `ab${FAMILY}`);
    assertEquals(truncateGraphemes(`ab${FLAG}cd`, 3), "ab"); // bandera necesita 4
    assertEquals(truncateGraphemes(`ab${FLAG}cd`, 6), `ab${FLAG}`);
    assertEquals(truncateGraphemes(`ab${SKIN}cd`, 3), "ab");
    assertEquals(truncateGraphemes(`ab${COMBINING}cd`, 3), "ab"); // "e" sin sus combinantes sería otro texto
    assertEquals(truncateGraphemes(`ab${COMBINING}cd`, 5), `ab${COMBINING}`);
    assertEquals(truncateGraphemes(`ab😊cd`, 3), "ab"); // antes: slice dejaba un surrogate alto
  });

  Deno.test(`${name}: truncateGraphemes cuenta el ellipsis dentro del máximo`, () => {
    const out = truncateGraphemes("abcdefghij", 5, { ellipsis: "…" });
    assertEquals(out, "abcd…");
    assertEquals(out.length, 5);
    assertEquals(truncateGraphemes(`ab😊cdef`, 5, { ellipsis: "…" }), "ab😊…");
    assertEquals(truncateGraphemes(`ab😊cdef`, 4, { ellipsis: "…" }), "ab…");
    // el sufijo no cabe: el tope duro manda
    assertEquals(truncateGraphemes("abcdef", 1, { ellipsis: "…" }), "a");
    assertEquals(truncateGraphemes("abcdef", 3, { ellipsis: "[truncado]" }), "abc");
  });

  Deno.test(`${name}: truncateGraphemes con wordBoundary corta en el último espacio`, () => {
    assertEquals(truncateGraphemes("hola mundo cruel", 12, { wordBoundary: true }), "hola mundo");
    assertEquals(truncateGraphemes("hola mundo cruel", 10, { wordBoundary: true }), "hola mundo"); // cae justo en frontera
    assertEquals(truncateGraphemes("supercalifragilistico", 8, { wordBoundary: true }), "supercal"); // sin espacios: corte duro
    assertEquals(truncateGraphemes(`hola ${FAMILY}${FAMILY}`, 9, { wordBoundary: true }), "hola");
    assertEquals(truncateGraphemes("a b", 10, { wordBoundary: true }), "a b");
  });

  Deno.test(`${name}: truncateGraphemes entradas degeneradas`, () => {
    assertEquals(truncateGraphemes("abc", 0), "");
    assertEquals(truncateGraphemes("abc", -3), "");
    assertEquals(truncateGraphemes("abc", NaN), "");
    assertEquals(truncateGraphemes("", 5), "");
    assertEquals(truncateGraphemes(null as unknown as string, 5), "");
    assertEquals(truncateGraphemes(`${HIGH}`, 5), "");
    assertEquals(truncateGraphemes(FAMILY, 3), ""); // ningún grafema cabe
  });

  Deno.test(`${name}: truncateGraphemes — inputs con surrogates sueltos en cualquier posición`, () => {
    const base = `hola ${FAMILY} qué tal ${FLAG} ${SKIN} bien 😊 fin`;
    const rotos = [
      `${HIGH}${base}`, `${LOW}${base}`, `${base}${HIGH}`, `${base}${LOW}`,
      `hola ${HIGH}${FAMILY}`, `hola ${LOW}${FAMILY}`, base.replace("qué", `q${HIGH}ué`), base.replace("tal", `t${LOW}al`),
      `${HIGH}${HIGH}${LOW}${LOW}${base}`,
    ];
    for (const rota of rotos) {
      for (let max = 0; max <= rota.length + 2; max++) {
        for (const opts of [{}, { ellipsis: "…" }, { wordBoundary: true }, { ellipsis: "…", wordBoundary: true }]) {
          const out = truncateGraphemes(rota, max, opts);
          assertTransportSafe(out);
          assert(out.length <= max, `max=${max} length=${out.length}`);
        }
      }
    }
  });

  Deno.test(`${name}: truncateGraphemes — barrido exhaustivo: cortar emojis nunca excede ni deja basura`, () => {
    const mezcla = `😊${FAMILY}${FLAG}${SKIN}${COMBINING}${KEYCAP}ñ`.repeat(6);
    for (let max = 0; max <= mezcla.length + 1; max++) {
      const out = truncateGraphemes(mezcla, max, { ellipsis: "…" });
      assertTransportSafe(out);
      assert(out.length <= max);
      // Todo lo que no es el sufijo es un prefijo exacto del original: no se inventa ni reordena nada.
      const cuerpo = out.endsWith("…") && out !== mezcla ? out.slice(0, -1) : out;
      assert(mezcla.startsWith(cuerpo));
    }
  });

  Deno.test(`${name}: el máximo se respeta también contando code points y grafemas`, () => {
    const out = truncateGraphemes(FAMILY.repeat(40), 280, { wordBoundary: true });
    assert(out.length <= 280);
    assert([...out].length <= 280);
    assert([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(out)].length <= 280);
    assertEquals(out, FAMILY.repeat(25)); // 25 * 11 = 275
  });

  Deno.test(`${name}: firstGrapheme devuelve el primer grafema entero`, () => {
    assertEquals(firstGrapheme("Ana"), "A");
    assertEquals(firstGrapheme(`${FAMILY} casa`), FAMILY);
    assertEquals(firstGrapheme(`${FLAG}x`), FLAG);
    assertEquals(firstGrapheme(`${HIGH}Ana`), "A");
    assertEquals(firstGrapheme(""), "");
  });
}

Deno.test("paridad: web/src/lib/text-safe.ts es idéntico a _shared/text-safe.ts", async () => {
  const a = await Deno.readTextFile(new URL("./text-safe.ts", import.meta.url));
  const b = await Deno.readTextFile(new URL("../../../web/src/lib/text-safe.ts", import.meta.url));
  assertEquals(b, a, "las dos copias divergieron: sincronízalas");
  assertNotEquals(a.length, 0);
});

Deno.test("regresión: slice(0, n) sí dejaba un surrogate suelto (el bug original)", () => {
  const roto = `ab😊cd`.slice(0, 3);
  assert(hasLoneSurrogate(roto));
  assert(!hasLoneSurrogate(shared.truncateGraphemes(`ab😊cd`, 3)));
});
