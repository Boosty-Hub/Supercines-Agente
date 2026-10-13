// Comparación de la posición esperada de un lead (pura, sin imports).
//
// El cliente manda con cada movimiento la posición que cree vigente
// (`expected: { pipeline_id, stage_id }`, cada una number|null). El servidor la compara
// con la de la base ANTES de tocar Kommo, de forma atómica con la reserva del lead
// (claim_lead_move, migración 0061): si no coincide, otro movimiento (de este panel o hecho
// en Kommo) llegó en el medio y este ya está desactualizado → 409. `expected` ausente =
// sin chequeo (clientes viejos).

export type ExpectedPosition = { pipeline_id: number | null; stage_id: number | null };

/** Lee `expected` del cuerpo. undefined = no enviado; null = enviado pero inválido. */
export function parseExpected(raw: unknown): ExpectedPosition | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null | undefined => {
    if (v === null) return null;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const pipeline_id = num(o.pipeline_id);
  const stage_id = num(o.stage_id);
  if (pipeline_id === undefined || stage_id === undefined) return null;
  return { pipeline_id, stage_id };
}
