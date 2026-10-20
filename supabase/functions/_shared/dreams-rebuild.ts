// _shared/dreams-rebuild.ts
// Núcleo de la reconstrucción del digest de Dreams (dreams-run → rebuildDigest), sin I/O
// propio: las llamadas al modelo, la base y el Memory Store llegan inyectadas para poder
// probarlo.
//
// Orden (ver dreams-run/index.ts y dreams-digest-render.ts):
//   1) planArchive decide qué archivar: exceso sobre DREAMS_MAX_ACTIVE y/o los dreams MÁS
//      VIEJOS que hagan falta para que el digest entre en DREAMS_DIGEST_MAX_WORDS. Su esencia
//      entra al resumen archivado (única consolidación con modelo que llega al agente, con su
//      chequeo de pérdida: nunca se congela), se guarda ese resumen y RECIÉN después se mueven
//      los archivos;
//      Si el archivado FALLA (refusal, corte, red, salida sin viñetas) NO se lanza: alerta
//      `archive_failed`, no se archiva nada en esta corrida, el digest se arma con TODOS los
//      activos (con digest_over_cap si pasa el tope) y se persiste; `archiveFailed` le dice al
//      llamador que NO guarde el fingerprint, así la próxima corrida reintenta archivar. Sin
//      esto un archivado roto congelaba el digest: borrar o aprobar un dream no llegaba al agente;
//   2) el digest se ARMA sin modelo (renderDigest) con los activos que quedan + el resumen
//      archivado. Si aun así pasa el tope, se guarda COMPLETO y se avisa (digest_over_cap):
//      nunca se recortan reglas;
//   3) notas del operador: llamada aparte; si falla quedan las anteriores. No toca el digest.
// El llamador persiste el digest, las notas y el fingerprint con lo que devuelve.

import {
  ConsolidationMalformedError,
  consolidationMalformedAlert,
  consolidateWithLossCheck,
  consolidationDataShapeAlert,
  type ConsolidationAttempt,
  consolidationLossAlert,
  dataShapeNote,
  mergeOperatorNotes,
  type DreamLike,
  inputRuleCount,
  type LossInfo,
  type PersistedLoss,
} from "./dreams-consolidation.ts";
import { DATA_SHAPE_NOTE_PREFIX } from "./dreams-facts.ts";
import { digestOverCapAlert, OPERATOR_NOTE_PREFIX, planArchive, renderDigest } from "./dreams-digest-render.ts";

export type ArchivedText = {
  text: string;
  /** Viñetas que salieron por un dato de alto riesgo (finalizeArchive). */
  dataShapeRemoved?: string[];
};

/**
 * Alerta (`dream_error`) de un archivado que falló: el resumen archivado vivo no se tocó,
 * ningún dream se movió y el digest se armó con TODOS los activos. Se reintenta en la próxima
 * reconstrucción (no se guarda el fingerprint).
 */
export function archiveFailedAlert(err: unknown, pending: number) {
  const malformed = err instanceof ConsolidationMalformedError;
  const detail = malformed
    ? `el modelo devolvió un texto sin ninguna viñeta para ${err.inputRules} reglas de entrada (${err.attempts} intentos)`
    : `error del modelo o de la red (${(err instanceof Error ? err.message : String(err)).slice(0, 200)})`;
  return {
    kind: "dream_error" as const,
    severity: "warning" as const,
    title: "Dreams: no se pudieron archivar los aprendizajes más viejos",
    description:
      `El archivado de ${pending} ${pending === 1 ? "aprendizaje" : "aprendizajes"} falló: ${detail}. ` +
      "No se movió ningún archivo y el resumen archivado sigue igual; el digest del agente se armó con TODOS los aprendizajes activos. " +
      "La próxima reconstrucción lo vuelve a intentar.",
    metadata: {
      reason: "archive_failed",
      pending,
      malformed,
      ...(malformed ? { input_rules: err.inputRules, attempts: err.attempts } : {}),
    },
  };
}

type AlertRow =
  | ReturnType<typeof archiveFailedAlert>
  | ReturnType<typeof consolidationLossAlert>
  | ReturnType<typeof consolidationMalformedAlert>
  | ReturnType<typeof consolidationDataShapeAlert>
  | ReturnType<typeof digestOverCapAlert>;

export type RebuildDeps<D extends DreamLike> = {
  /** Consolidación de ARCHIVADO: una llamada al modelo, ya medida (finalizeArchive). */
  consolidateArchive: (
    opts: { archived: string; dreams: D[]; maxWords: number },
    retry?: LossInfo,
  ) => Promise<ConsolidationAttempt<ArchivedText>>;
  /** Notas del operador (llamada aparte al modelo). Si lanza, quedan las anteriores. */
  operatorNotes: (opts: { archived: string; dreams: D[]; known: string[] }) => Promise<string>;
  /** «Gana la última en empezar»: false = otra reconstrucción más nueva ya corre. */
  stillLatest: () => Promise<boolean>;
  saveArchiveSummary: (summary: string) => Promise<void>;
  /** Mueve el dream a /dreams-archive/; true si quedó fuera de los activos. Fail-open. */
  archiveDream: (d: D) => Promise<boolean>;
  /** Inserta una alerta. Fail-open: un fallo acá nunca frena la reconstrucción. */
  alert: (row: AlertRow) => Promise<void>;
};

export type RebuildCoreResult<D extends DreamLike> =
  | { superseded: true; archivedCount: number }
  | {
    superseded: false;
    archivedCount: number;
    archivedSummary: string;
    active: D[];
    digest: string;
    words: number;
    /** El digest quedó por encima del tope (se guardó completo, con alerta). */
    overCap: boolean;
    operatorNotes: string;
    /** La llamada de notas falló: `operatorNotes` son las anteriores (+ las de datos de ahora). */
    notesFailed: boolean;
    archiveLoss: PersistedLoss | null;
    /** El archivado falló (alerta archive_failed): el llamador NO guarda el fingerprint. */
    archiveFailed: boolean;
  };

// Notas deterministas (se recalculan en cada rebuild): las de datos y lo que los dreams le decían
// al operador. Ante una falla del modelo no se arrastran de las notas anteriores (se duplicarían).
const isDataShapeNote = (line: string) =>
  line.startsWith(`- ${DATA_SHAPE_NOTE_PREFIX}`) || line.startsWith(`- ${OPERATOR_NOTE_PREFIX} («`);

export async function rebuildDigestCore<D extends DreamLike>(
  input: {
    archived: string;
    dreams: D[];
    maxWords: number;
    maxActive: number;
    archiveBatch: number;
    /** DREAMS_OPERATOR_NOTES vigente: se conserva si la llamada de notas falla. */
    previousNotes: string;
  },
  deps: RebuildDeps<D>,
): Promise<RebuildCoreResult<D>> {
  const { maxWords } = input;
  let archivedSummary = input.archived;
  const alert = async (row: AlertRow) => {
    try {
      await deps.alert(row);
    } catch (err) {
      console.warn(`alert dream_error (${row.metadata.reason}):`, err instanceof Error ? err.message : String(err));
    }
  };

  // 1) Archivado: la esencia entra al resumen ANTES de mover nada. Un error real (refusal,
  //    corte, red, salida sin viñetas) no archiva nada en esta corrida (alerta archive_failed)
  //    y el digest sigue con todos los activos; una PÉRDIDA no: se guarda igual con alerta.
  const plan = planArchive({
    dreams: input.dreams,
    archived: archivedSummary,
    maxWords,
    maxActive: input.maxActive,
    batch: input.archiveBatch,
  });
  let archivedCount = 0;
  let archiveLoss: PersistedLoss | null = null;
  let archiveRemoved: string[] = [];
  const archivedPaths = new Set<string>();
  let archiveFailed = false;
  let r: { value: ArchivedText; loss: PersistedLoss | null } | null = null;
  if (plan.toArchive.length > 0) {
    try {
      r = await consolidateWithLossCheck(
        inputRuleCount({ archived: archivedSummary, dreams: plan.toArchive }),
        plan.archiveMaxWords,
        (retry) => deps.consolidateArchive({ archived: archivedSummary, dreams: plan.toArchive, maxWords: plan.archiveMaxWords }, retry),
      );
    } catch (err) {
      archiveFailed = true;
      console.warn("dreams: archivado falló, el digest sigue con todos los activos:", err instanceof Error ? err.message : String(err));
      await alert(archiveFailedAlert(err, plan.toArchive.length));
    }
  }
  if (r) {
    const toArchive = plan.toArchive;
    if (!(await deps.stillLatest())) return { superseded: true, archivedCount: 0 };
    archivedSummary = r.value.text;
    await deps.saveArchiveSummary(archivedSummary);
    archiveRemoved = r.value.dataShapeRemoved ?? [];
    archiveLoss = r.loss;
    if (archiveLoss) await alert(consolidationLossAlert(archiveLoss));
    for (const d of toArchive) {
      if (await deps.archiveDream(d)) {
        archivedCount++;
        archivedPaths.add(d.path);
      }
    }
  }

  // 2) Digest armado SIN modelo: activos que quedan + resumen archivado.
  const active = input.dreams.filter((d) => !archivedPaths.has(d.path));
  const rendered = renderDigest(active, archivedSummary);
  const overCap = rendered.words > maxWords;

  // 3) Notas del operador: las de datos (determinísticas) + las del modelo. Si el modelo
  //    falla, se conservan las notas anteriores del modelo.
  const deterministicNotes = [...rendered.notes, ...archiveRemoved.map(dataShapeNote), ...rendered.operatorNotes];
  let llmNotes = "";
  let notesFailed = false;
  if (active.length > 0 || archivedSummary.trim()) {
    try {
      llmNotes = (await deps.operatorNotes({ archived: archivedSummary, dreams: active, known: deterministicNotes })).trim();
    } catch (err) {
      notesFailed = true;
      console.warn("dreams: notas del operador:", err instanceof Error ? err.message : String(err));
      llmNotes = input.previousNotes.split("\n").filter((l) => !isDataShapeNote(l)).join("\n").trim();
    }
  }

  if (!(await deps.stillLatest())) {
    // El resumen archivado YA se guardó: su alerta de datos vale aunque el digest se descarte.
    if (archiveRemoved.length > 0) await alert(consolidationDataShapeAlert({ digest: 0, archive: archiveRemoved.length }));
    return { superseded: true, archivedCount };
  }
  if (rendered.notes.length + archiveRemoved.length > 0) {
    console.warn(`dreams: ${rendered.notes.length + archiveRemoved.length} viñetas con dato de alto riesgo fuera del digest/resumen`);
    await alert(consolidationDataShapeAlert({ digest: rendered.notes.length, archive: archiveRemoved.length }));
  }
  if (overCap) {
    console.warn(`dreams: digest de ${rendered.words} palabras (tope ${maxWords}) — se guarda completo`);
    await alert(digestOverCapAlert({
      words: rendered.words,
      maxWords,
      activeCount: active.length,
      archiveWords: renderDigest([], archivedSummary).words,
    }));
  }
  // Sin repetidos: lo determinista va primero y lo del modelo (o las notas anteriores si falló)
  // solo suma lo que no diga ya algo igual o casi igual.
  const operatorNotes = mergeOperatorNotes(deterministicNotes, llmNotes);
  return {
    superseded: false,
    archivedCount,
    archivedSummary,
    active,
    digest: rendered.text,
    words: rendered.words,
    overCap,
    operatorNotes,
    notesFailed,
    archiveLoss,
    archiveFailed,
  };
}
