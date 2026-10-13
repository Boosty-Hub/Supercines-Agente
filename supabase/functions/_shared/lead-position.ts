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

// El webhook de Kommo es público y NO está firmado: aun con el secreto de la URL
// (_shared/webhook-auth.ts), el tiempo que declara el payload no se acepta a ciegas. Un
// last_modified en el futuro congelaría al lead (todo evento real posterior sería
// «viejo» y se descartaría), y eso decide si el agente responde.
/** Margen de reloj tolerado hacia el futuro respecto de la llegada. */
export const MAX_FUTURE_SKEW_MS = 2 * 60_000;
/** Diferencia con la llegada más allá de la cual el dato no es creíble (en ambos sentidos). */
export const MAX_ABSURD_DIFF_MS = 7 * 86_400_000;

/**
 * Instante (ms) en que ocurrió el cambio. Kommo lo informa en segundos Unix
 * (`last_modified`, o `updated_at`). Reglas:
 *  - falta / no es un número: la hora de llegada del webhook a la cola (`fallbackMs`);
 *  - diferencia absurda con la llegada (más de 7 días, hacia cualquier lado): la hora de
 *    llegada, y un warning;
 *  - hasta 2 min en el futuro (reloj desfasado): se respeta; más allá, se recorta a
 *    llegada + 2 min, con warning;
 *  - un evento VIEJO legítimo (llegó tarde o invertido) conserva su instante: el orden
 *    entre dos payloads del mismo lead es el que Kommo declara.
 */
export function eventInstantMs(change: KommoLeadChange, fallbackMs: number): number {
  const secs = positiveInt(change.last_modified) ?? positiveInt(change.updated_at);
  if (secs === null) return fallbackMs;
  const ms = secs * 1000;
  const diff = ms - fallbackMs;
  if (Math.abs(diff) > MAX_ABSURD_DIFF_MS) {
    console.warn(`lead-position: instante absurdo (${new Date(ms).toISOString()}) para el lead ${String(change.id)}; se usa la hora de llegada`);
    return fallbackMs;
  }
  if (diff > MAX_FUTURE_SKEW_MS) {
    console.warn(`lead-position: instante en el futuro (${new Date(ms).toISOString()}) para el lead ${String(change.id)}; se recorta`);
    return fallbackMs + MAX_FUTURE_SKEW_MS;
  }
  return ms;
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
