// _shared/dreams-digest-cap.ts
//
// CORTE DURO de palabras para el texto que Dreams pide al MODELO: el resumen archivado
// (DREAMS_ARCHIVE_DIGEST, finalizeArchive) y las notas del operador (finalizeOperatorNotes).
// El tope va como instrucción en el prompt y el modelo no siempre la respeta (KIA, ago-2026:
// 1.290 palabras contra 900 pedidas), así que se recorta de verdad antes de persistir. En el
// resumen archivado lo que se lleva el corte cuenta como pérdida (reintento + alerta:
// consolidateWithLossCheck).
//
// NO se aplica al digest del agente (DREAMS_DIGEST): ese se arma sin modelo y nunca se
// recortan reglas (dreams-digest-render.ts).
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
