// _shared/lead-position.ts
// Lógica PURA (sin I/O) con que process-inbound interpreta lo que Kommo avisa de
// un lead (`leads.update` / `leads.status`). La DECISIÓN de si se aplica (¿es más
// nuevo que lo guardado?, ¿fue un movimiento?) la toma la base, atómicamente, en
// apply_lead_position() (migración 0061): acá solo se extrae la posición y el
// instante del evento.
//
// Contexto de volumen: esos dos eventos son ~64% del tráfico del webhook y casi
// todos son de OTROS campos (tags, precio, responsable). apply_lead_position no
// escribe nada cuando la etapa y el pipeline no cambiaron.

/** Lo que Kommo manda por lead en el webhook (los ids y los instantes llegan como string). */
export type KommoLeadChange = {
  id?: string | number;
  status_id?: string | number;
  pipeline_id?: string | number;
  /** Unix en segundos del último cambio del lead (webhooks de leads). */
  last_modified?: string | number;
  updated_at?: string | number;
  // El webhook trae más campos (name, responsible_user_id, ...): no importan acá.
  [campo: string]: unknown;
};

export type LeadPosition = {
  kommoLeadId: number;
  statusId: number;
  /** null = el webhook no trajo pipeline_id (no se pisa el que ya hay). */
  pipelineId: number | null;
  /** Instante del evento en ms: el que informa Kommo, o el de llegada a la cola. */
  atMs: number;
};

function positiveInt(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Instante (ms) en que ocurrió el cambio. Kommo lo informa en segundos Unix
 * (`last_modified`, o `updated_at`). Si falta o no es plausible se usa el de
 * llegada del webhook a la cola (`fallbackMs`): nunca es anterior al hecho, y el
 * orden entre dos payloads del mismo lead sigue siendo el de llegada.
 */
export function eventInstantMs(change: KommoLeadChange, fallbackMs: number): number {
  const secs = positiveInt(change.last_modified) ?? positiveInt(change.updated_at);
  // Más de ~1 día en el futuro respecto de la llegada = dato corrupto, no se confía.
  if (secs !== null && secs * 1000 <= fallbackMs + 86_400_000) return secs * 1000;
  return fallbackMs;
}

/**
 * Extrae la posición (etapa + pipeline) de un lead del webhook. Devuelve null si
 * no trae etapa: es un cambio de otro campo y no hay nada que sincronizar.
 */
export function parseLeadPosition(l: KommoLeadChange, fallbackMs: number): LeadPosition | null {
  const kommoLeadId = positiveInt(l.id);
  const statusId = positiveInt(l.status_id);
  if (kommoLeadId === null || statusId === null) return null;
  return { kommoLeadId, statusId, pipelineId: positiveInt(l.pipeline_id), atMs: eventInstantMs(l, fallbackMs) };
}
