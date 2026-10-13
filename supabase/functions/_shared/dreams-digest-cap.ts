// _shared/dreams-digest-cap.ts
//
// CORTE DURO para el digest rodante de Dreams (runtime_config.DREAMS_DIGEST).
//
// `dreams-run/index.ts` le pide al modelo un digest de máximo N palabras
// (DIGEST_MAX_WORDS) como INSTRUCCIÓN dentro del prompt de rebuildDigest, y el
// modelo no siempre la respeta: medido en producción (KIA-Agente, 19-ago) el
// digest vivo pesaba 7.726 chars (~1.290 palabras, ~1.932 tokens) contra un
// tope pedido de 900. Ese bloque se inyecta —y se ESCRIBE A CACHÉ— en CADA
// sesión de CADA lead, así que cada palabra de más se paga muchas veces por
// día (el cache_write es una porción grande del costo por sesión). Una
// instrucción blanda en el prompt no alcanza: hay que recortar de verdad,
// después de que el modelo generó el texto y antes de persistirlo.
//
// Es lógica puramente mecánica (contar palabras, truncar por línea completa)
// y no depende de negocio de ningún cliente — vive en _shared para poder
// testearla sin levantar Supabase ni el cliente de Anthropic.
//
// Corta por viñetas/líneas completas, nunca a mitad de una frase, y conserva
// los encabezados de sección para que el bloque siga siendo legible. Si el
// corte deja encabezados colgando al final (sin contenido debajo), se quitan.
export function enforceDigestWordCap(text: string, maxWords: number): string {
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  if (words(text) <= maxWords) return text;

  const out: string[] = [];
  let used = 0;
  let hayContenido = false;

  for (const line of text.split("\n")) {
    const w = words(line);
    // Los encabezados son baratos y dan estructura: se conservan siempre.
    const esEncabezado = /^\s*#{1,6}\s/.test(line);

    if (!esEncabezado) {
      // GARANTÍA: al menos una línea de contenido sobrevive SIEMPRE, aunque no
      // entre en el presupuesto. Sin esto, un digest cuya primera viñeta sea
      // más larga que el tope se borraba ENTERO —los encabezados sueltos los
      // limpia el barrido de abajo— y el operador perdía en silencio todos sus
      // aprendizajes acumulados. Un digest pasado de tope es un costo; un
      // digest vacío es una pérdida de datos.
      if (hayContenido && used + w > maxWords) break;
      hayContenido = true;
    }

    out.push(line);
    used += w;
  }

  // Si el recorte dejó encabezados (o líneas en blanco) colgando al final sin
  // contenido debajo, se quitan: un título solo no le dice nada al modelo.
  while (out.length && /^\s*(#{1,6}\s|\s*$)/.test(out[out.length - 1])) out.pop();

  return out.join("\n").trim();
}
