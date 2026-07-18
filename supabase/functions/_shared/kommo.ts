// _shared/kommo.ts
// Helpers reutilizables para interactuar con la API de Kommo CRM.
// Copiados verbatim de publish-to-kommo/index.ts para evitar duplicación.
//
// Uso:
//   import { patchLeadField, runSalesbot } from "../_shared/kommo.ts";

/**
 * Actualiza un custom field de un lead en Kommo.
 * Throws si la respuesta no es OK.
 */
// Los campos de texto de Kommo NO aceptan caracteres de 4 bytes (fuera del BMP):
// guardan el texto TRUNCADO desde el primer emoji en adelante, sin avisar. Con
// un emoji en la primera línea, el campo queda prácticamente vacío y al cliente
// no le llega nada. Verificado contra la cuenta real:
//
//   "ANTES 🎬 DESPUES" (16 chars) → se guarda "ANTES " (6 chars)
//   "🎬 al inicio"     (12 chars) → se guarda ""       (0 chars)
//   600 chars sin emoji           → se guarda entero (no es límite de largo)
//
// Es el típico utf8 (3 bytes) en vez de utf8mb4 del lado de Kommo. Como la voz
// del agente usa emoji a full, hay que sanear ANTES de escribir: los que tienen
// equivalente dentro del BMP se mapean para no perder el tono, el resto se cae.
const BMP_EQUIVALENTE: Record<string, string> = {
  "🕐": "⏰", "🕒": "⏰", "🕓": "⏰", "🕗": "⏰", "⌚": "⌚",
  "🎟": "🎫", // ambos no-BMP: cae al strip, queda por claridad del intento
  "⭐": "⭐", "❤️": "❤", "✔️": "✔", "⚠️": "⚠", "➡️": "➡",
};

/** Deja el texto guardable en un campo de Kommo (solo BMP). */
export function sanitizeForKommoField(input: string): string {
  const out: string[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x200d) continue; // selector de variación / ZWJ huérfanos
    if (cp > 0xffff) {
      const alt = BMP_EQUIVALENTE[ch];
      if (alt && (alt.codePointAt(0) ?? 0) <= 0xffff) out.push(alt);
      continue; // sin equivalente BMP → se descarta
    }
    out.push(ch);
  }
  return out
    .join("")
    .replace(/[ \t]{2,}/g, " ") // espacios que quedaron de los emoji borrados
    .replace(/^[ \t]+/gm, "") // emoji al principio de línea → no dejar sangría
    .replace(/[ \t]+$/gm, "")
    .replace(/^([|·—-]\s*)+/gm, "") // separadores que quedaron colgando
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function patchLeadField(
  kommoLeadId: number,
  fieldId: number,
  value: string,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}`;
  const safe = sanitizeForKommoField(value);
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      custom_fields_values: [
        {
          field_id: fieldId,
          values: [{ value: safe }],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`patch lead: ${res.status} ${await res.text()}`);
  }
}

/**
 * Actualiza un custom field de un CONTACTO en Kommo (mismo shape que el lead,
 * pero el endpoint apunta a /contacts/). Throws si la respuesta no es OK.
 */
export async function patchContactField(
  kommoContactId: number,
  fieldId: number,
  value: string,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v4/contacts/${kommoContactId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      custom_fields_values: [
        {
          field_id: fieldId,
          values: [{ value }],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`patch contact: ${res.status} ${await res.text()}`);
  }
}

/**
 * Mueve un lead a otra etapa (status_id) de Kommo, opcionalmente cambiando de
 * pipeline. Throws si la respuesta no es OK.
 */
export async function moveLeadStage(
  kommoLeadId: number,
  statusId: number,
  pipelineId: number | null,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const body: Record<string, unknown> = { status_id: statusId };
  if (pipelineId != null) body.pipeline_id = pipelineId;
  const url = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`move lead stage: ${res.status} ${await res.text()}`);
  }
}

// Status IDs reservados/universales de Kommo: 142 = GANADO (won), 143 = PERDIDO
// (lost). Existen en TODOS los pipelines. Un lead en cualquiera de estas etapas
// es terminal y nunca debe recibir seguimiento.
export const KOMMO_WON_STATUS = 142;
export const KOMMO_LOST_STATUS = 143;

/**
 * Trae el snapshot EN VIVO de un lead desde Kommo: etapa (status_id +
 * pipeline_id) y responsable asignado (responsible_user_id). Fuente de verdad
 * autoritativa — a diferencia del cache local `kommo_stage_id`, que solo se
 * refresca con inbounds y movimientos del agente. Throws si !OK.
 */
export async function fetchLeadStage(
  kommoLeadId: number,
  kommoDomain: string,
  kommoToken: string
): Promise<{ statusId: number; pipelineId: number; responsibleUserId: number | null }> {
  const url = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${kommoToken}` },
  });
  if (!res.ok) {
    throw new Error(`fetch lead stage: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    status_id?: number;
    pipeline_id?: number;
    responsible_user_id?: number;
  };
  const ruid = json.responsible_user_id;
  return {
    statusId: Number(json.status_id),
    pipelineId: Number(json.pipeline_id),
    responsibleUserId: ruid == null ? null : Number(ruid),
  };
}

export type KommoStageLite = {
  id: number;
  name: string;
  pipelineId: number;
  pipelineName: string;
};

/**
 * Trae TODAS las etapas (status) de todos los pipelines de Kommo, aplanadas,
 * para resolver una etapa POR NOMBRE → status_id + pipeline_id.
 */
export async function fetchPipelineStages(
  kommoDomain: string,
  kommoToken: string
): Promise<KommoStageLite[]> {
  const url = `https://${kommoDomain}/api/v4/leads/pipelines`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${kommoToken}` },
  });
  if (!res.ok) {
    throw new Error(`fetch pipelines: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    _embedded?: {
      pipelines?: Array<{
        id: number;
        name: string;
        _embedded?: { statuses?: Array<{ id: number; name: string }> };
      }>;
    };
  };
  const out: KommoStageLite[] = [];
  for (const p of json._embedded?.pipelines ?? []) {
    for (const s of p._embedded?.statuses ?? []) {
      out.push({ id: s.id, name: s.name, pipelineId: p.id, pipelineName: p.name });
    }
  }
  return out;
}

export type KommoFieldLite = { id: number; name: string };

/**
 * Trae los custom fields de leads o contacts de Kommo para resolver un campo
 * POR NOMBRE → field_id. 204 = sin campos.
 */
export async function fetchEntityFields(
  entity: "leads" | "contacts",
  kommoDomain: string,
  kommoToken: string
): Promise<KommoFieldLite[]> {
  const url = `https://${kommoDomain}/api/v4/${entity}/custom_fields?limit=250`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${kommoToken}` },
  });
  if (res.status === 204) return [];
  if (!res.ok) {
    throw new Error(`fetch ${entity} fields: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    _embedded?: { custom_fields?: Array<{ id: number; name: string }> };
  };
  return (json._embedded?.custom_fields ?? []).map((f) => ({ id: f.id, name: f.name }));
}

/**
 * Dispara un salesbot de Kommo sobre un lead.
 * Endpoint legacy v2 (sigue soportado en cuentas v4).
 * Throws si la respuesta no es OK.
 */
export async function runSalesbot(
  botId: number,
  kommoLeadId: number,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v2/salesbot/run`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      {
        bot_id: botId,
        entity_id: kommoLeadId,
        entity_type: 2, // 2 = lead
      },
    ]),
  });
  if (!res.ok) {
    throw new Error(`run salesbot: ${res.status} ${await res.text()}`);
  }
}
