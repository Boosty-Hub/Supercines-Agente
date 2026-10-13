// _shared/lead-position.ts
// Lógica PURA (sin I/O) con que process-inbound decide qué hacer cuando Kommo
// avisa que un lead cambió (`leads.update` / `leads.status`).
//
// Está separada de process-inbound/index.ts por dos motivos: se puede testear
// sin Deno.serve ni Supabase, y es el punto donde se juega el volumen — esos dos
// eventos son ~64% del tráfico del webhook y casi todos son de OTROS campos
// (tags, precio, responsable). La regla de oro es "escribir solo si cambió".

/** Lo que Kommo manda por lead en el webhook (los ids llegan como string). */
export type KommoLeadChange = {
  id?: string | number;
  status_id?: string | number;
  pipeline_id?: string | number;
  // El webhook trae más campos (name, responsible_user_id, ...): no importan acá.
  [campo: string]: unknown;
};

export type LeadPosition = {
  kommoLeadId: number;
  statusId: number;
  /** null = el webhook no trajo pipeline_id (no se pisa el que ya hay). */
  pipelineId: number | null;
};

function positiveInt(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Extrae la posición (etapa + pipeline) de un lead del webhook. Devuelve null
 * si no trae etapa: es un cambio de otro campo y no hay nada que sincronizar.
 */
export function parseLeadPosition(l: KommoLeadChange): LeadPosition | null {
  const kommoLeadId = positiveInt(l.id);
  const statusId = positiveInt(l.status_id);
  if (kommoLeadId === null || statusId === null) return null;
  return { kommoLeadId, statusId, pipelineId: positiveInt(l.pipeline_id) };
}

export type StoredPosition = { stageId: number | null; pipelineId: number | null };
export type IncomingPosition = { stageId: number; pipelineId: number | null };

export type PositionPlan = {
  /** ¿Hay algo que escribir en `leads`? false = no tocar la fila. */
  write: boolean;
  patch: { kommo_stage_id?: number; kommo_pipeline_id?: number };
  /** ¿Es un movimiento real (para lead_stage_events)? */
  recordEvent: boolean;
};

/**
 * Compara lo guardado con lo que informa Kommo.
 *
 *  - Igual → no se escribe nada (cada UPDATE a `leads` dispara un refresco en
 *    vivo en todos los inbox abiertos).
 *  - Distinto → se escribe etapa y, si vino, pipeline.
 *  - Es un MOVIMIENTO solo si ya había etapa previa: null → etapa es la primera
 *    vez que la vemos, no un cambio. Y cambiar de pipeline conservando el id de
 *    etapa también cuenta (142/143 existen en todos los pipelines).
 */
export function planPositionChange(prev: StoredPosition, next: IncomingPosition): PositionPlan {
  const stageChanged = prev.stageId === null || Number(prev.stageId) !== next.stageId;
  const pipelineChanged =
    next.pipelineId !== null && (prev.pipelineId === null || Number(prev.pipelineId) !== next.pipelineId);
  if (!stageChanged && !pipelineChanged) return { write: false, patch: {}, recordEvent: false };

  const patch: PositionPlan["patch"] = { kommo_stage_id: next.stageId };
  if (next.pipelineId !== null) patch.kommo_pipeline_id = next.pipelineId;

  const hadStage = prev.stageId !== null;
  const pipelineMoved =
    prev.pipelineId !== null && next.pipelineId !== null && Number(prev.pipelineId) !== next.pipelineId;
  const recordEvent = hadStage && (Number(prev.stageId) !== next.stageId || pipelineMoved);
  return { write: true, patch, recordEvent };
}
