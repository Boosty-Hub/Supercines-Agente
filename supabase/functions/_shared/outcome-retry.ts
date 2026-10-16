// _shared/outcome-retry.ts — cuándo evaluate-outcomes vuelve a correr un grader sobre un draft.
//
// Antes: si existía CUALQUIER fila (draft, grader) se salteaba, incluidas las de ERROR
// (score NULL, metadata.error=true). Un fallo pasajero o un bug ya corregido (p. ej. el
// 400 por schema sin additionalProperties:false) dejaba esas evaluaciones en ERROR para
// siempre y había que borrarlas a mano. Ahora una fila de ERROR se reintenta hasta
// MAX_ERROR_ATTEMPTS veces (el contador vive en metadata.error_attempts): suficiente
// para recuperarse de un error pasajero o de un deploy con el arreglo, sin martillar al
// modelo con un error determinístico (refusal) en cada barrido de 5 min.

export const MAX_ERROR_ATTEMPTS = 3;

export type ExistingOutcome = { score: number | null; metadata: unknown };

function isErrorRow(o: ExistingOutcome): boolean {
  const m = o.metadata as Record<string, unknown> | null;
  return o.score === null && m != null && typeof m === "object" && m.error === true;
}

/** Intentos fallidos ya registrados (filas de ERROR viejas sin contador = 1). */
export function errorAttemptsOf(o: ExistingOutcome | undefined): number {
  if (!o || !isErrorRow(o)) return 0;
  const n = Number((o.metadata as Record<string, unknown>).error_attempts);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** ¿Hay que (re)evaluar este grader sobre este draft? */
export function shouldEvaluate(existing: ExistingOutcome | undefined, mutable: boolean): boolean {
  if (!existing) return true;
  if (mutable) return true;
  if (isErrorRow(existing)) return errorAttemptsOf(existing) < MAX_ERROR_ATTEMPTS;
  return false;
}
