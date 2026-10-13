// _shared/dreams-consolidation.ts
// Prompt de consolidación del digest de dreams (dreams-run), PURO y sin I/O para
// poder probar la propiedad que importa:
//
//   la consolidación se arma SOLO con (resumen de lo archivado + dreams ACTIVOS de
//   ahora). La función NO recibe el digest anterior: no existe forma de que una
//   regla de un dream ya borrado entre al prompt por esa vía.
//
// Por qué: con un digest "rodante" (digest anterior + activos), cuando el operador
// BORRABA un dream su regla seguía viva dentro del digest anterior y el consolidador
// la conservaba: borrar no tenía efecto. Ver dreams-run/index.ts.

export type DreamLike = { path: string; content: string };

export type ConsolidationPurpose = "digest" | "archive";

export function buildConsolidationPrompt(opts: {
  purpose: ConsolidationPurpose;
  operator: string;
  /** DREAMS_ARCHIVE_DIGEST: esencia de lo ya archivado (puede estar vacío). */
  archived: string;
  /** Dreams a fusionar: los ACTIVOS (digest) o los más antiguos a archivar (archive). */
  dreams: ReadonlyArray<DreamLike>;
  maxWords: number;
}): string {
  const body = opts.dreams.map((d) => `### ${d.path}\n${d.content}`).join("\n\n");
  const goal = opts.purpose === "digest"
    ? "Generá el DIGEST NUEVO que el agente aplicará antes de CADA respuesta."
    : "Generá el RESUMEN ARCHIVADO NUEVO: la esencia de los aprendizajes antiguos que salen de la lista activa y que el digest seguirá teniendo en cuenta.";
  return `Sos el consolidador de aprendizajes ("dreams") del agente de ${opts.operator}. ${goal}

RESUMEN DE APRENDIZAJES ARCHIVADOS (aprendizajes antiguos cuyos archivos ya no están activos; conservá su esencia salvo que los aprendizajes de abajo los contradigan):
${opts.archived || "(ninguno)"}

${opts.purpose === "digest" ? "APRENDIZAJES ACTIVOS (archivos /dreams/ vigentes)" : "APRENDIZAJES A ARCHIVAR (los más antiguos de /dreams/)"}:
${body || "(ninguno)"}

Reglas:
- Español, máximo ${opts.maxWords} palabras. Tres secciones: "## Errores a no repetir", "## Advertencias y gaps", "## Refuerzos y estilo" (omití la sección si queda vacía), con viñetas de UNA oración accionable cada una.
- Fusioná duplicados y variantes del mismo aprendizaje en una sola viñeta.
- Priorizá SIEMPRE los errores; si hay que recortar, recortá sugerencias.
- Descartá lo obsoleto o contradicho por aprendizajes más nuevos (gana el más nuevo).
- NO agregues aprendizajes que no estén en las fuentes. Sin preámbulo ni cierre: solo el texto.`;
}
