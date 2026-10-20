// _shared/dreams-rebuild.ts
// Núcleo de la reconstrucción del digest de Dreams (dreams-run → rebuildDigest), sin I/O
// propio: las llamadas al modelo, la base y el Memory Store llegan inyectadas para poder
// probar la garantía que importa:
//
//   NUNCA SE CONGELA. Una consolidación con pérdida de reglas se reintenta una vez y después
//   se PERSISTE igual (con alerta). Ni el archivado ni el digest abortan por pérdida, así que
//   borrar un dream SIEMPRE llega al agente en el siguiente rebuild y el archivado no repite
//   la misma tanda para siempre.
//
// Orden (ver dreams-run/index.ts):
//   1) si hay dreams a archivar: su esencia entra al resumen archivado (consolidación
//      «archive»), se guarda ese resumen y RECIÉN después se mueven los archivos;
//   2) el digest = resumen archivado + los activos que quedan (consolidación «digest»).
// El llamador persiste el digest, las notas y el fingerprint con lo que devuelve.

import {
  ConsolidationMalformedError,
  consolidationMalformedAlert,
  consolidateWithLossCheck,
  type ConsolidationAttempt,
  type ConsolidationPurpose,
  consolidationLossAlert,
  type DreamLike,
  inputRuleCount,
  type LossInfo,
  type PersistedLoss,
} from "./dreams-consolidation.ts";

export type ConsolidatedText = { text: string; operatorNotes: string };

export type RebuildDeps<D extends DreamLike> = {
  /** Una llamada al modelo, ya medida (finalizeDigest / finalizeArchive). */
  consolidate: (
    opts: { purpose: ConsolidationPurpose; archived: string; dreams: D[] },
    retry?: LossInfo,
  ) => Promise<ConsolidationAttempt<ConsolidatedText>>;
  /** «Gana la última en empezar»: false = otra reconstrucción más nueva ya corre. */
  stillLatest: () => Promise<boolean>;
  saveArchiveSummary: (summary: string) => Promise<void>;
  /** Mueve el dream a /dreams-archive/; true si quedó fuera de los activos. Fail-open. */
  archiveDream: (d: D) => Promise<boolean>;
  /** Inserta la alerta de pérdida. Fail-open: un fallo acá nunca frena la reconstrucción. */
  alert: (row: ReturnType<typeof consolidationLossAlert> | ReturnType<typeof consolidationMalformedAlert>) => Promise<void>;
};

export type RebuildCoreResult<D extends DreamLike> =
  | { superseded: true; archivedCount: number }
  | {
    superseded: false;
    archivedCount: number;
    archivedSummary: string;
    active: D[];
    digest: string;
    operatorNotes: string;
    losses: { archive: PersistedLoss | null; digest: PersistedLoss | null };
  };

export async function rebuildDigestCore<D extends DreamLike>(
  input: { archived: string; dreams: D[]; toArchive: D[]; maxWords: number },
  deps: RebuildDeps<D>,
): Promise<RebuildCoreResult<D>> {
  const { maxWords } = input;
  let archivedSummary = input.archived;
  const warn = async (purpose: ConsolidationPurpose, loss: PersistedLoss | null) => {
    if (!loss) return;
    try {
      await deps.alert(consolidationLossAlert(purpose, loss));
    } catch (err) {
      console.warn("alert dream_error (consolidación):", err instanceof Error ? err.message : String(err));
    }
  };
  const run = async (purpose: ConsolidationPurpose, archived: string, dreams: D[]) => {
    try {
      return await consolidateWithLossCheck(
        inputRuleCount({ archived, dreams }),
        maxWords,
        (retry) => deps.consolidate({ purpose, archived, dreams }, retry),
      );
    } catch (err) {
      // Salida sin ninguna viñeta (mal formada, no «con pérdida»): no se persiste (el valor
      // vivo queda) y se avisa. Lanza como cualquier error real del modelo.
      if (err instanceof ConsolidationMalformedError) {
        try {
          await deps.alert(consolidationMalformedAlert(purpose, err));
        } catch (e) {
          console.warn("alert dream_error (consolidación):", e instanceof Error ? e.message : String(e));
        }
      }
      throw err;
    }
  };

  // 1) Archivado: la esencia entra al resumen ANTES de mover nada. Un error real (refusal,
  //    corte, red) lanza y no se archiva en esta corrida; una PÉRDIDA no: se guarda igual.
  let archivedCount = 0;
  let archiveLoss: PersistedLoss | null = null;
  const archivedPaths = new Set<string>();
  if (input.toArchive.length > 0) {
    const r = await run("archive", archivedSummary, input.toArchive);
    if (!(await deps.stillLatest())) return { superseded: true, archivedCount: 0 };
    archivedSummary = r.value.text;
    await deps.saveArchiveSummary(archivedSummary);
    archiveLoss = r.loss;
    await warn("archive", archiveLoss);
    for (const d of input.toArchive) {
      if (await deps.archiveDream(d)) {
        archivedCount++;
        archivedPaths.add(d.path);
      }
    }
  }

  // 2) Digest = resumen archivado + los activos que quedan. Nunca parte del digest anterior.
  const active = input.dreams.filter((d) => !archivedPaths.has(d.path));
  let digest = "";
  let operatorNotes = "";
  let digestLoss: PersistedLoss | null = null;
  if (active.length > 0 || archivedSummary) {
    const r = await run("digest", archivedSummary, active);
    digest = r.value.text;
    operatorNotes = r.value.operatorNotes;
    digestLoss = r.loss;
  }
  if (!(await deps.stillLatest())) return { superseded: true, archivedCount };
  await warn("digest", digestLoss);
  return {
    superseded: false,
    archivedCount,
    archivedSummary,
    active,
    digest,
    operatorNotes,
    losses: { archive: archiveLoss, digest: digestLoss },
  };
}
