// _shared/kommo.ts
// Helpers reutilizables para interactuar con la API de Kommo CRM.
// Copiados verbatim de publish-to-kommo/index.ts para evitar duplicación.
//
// Uso:
//   import { patchLeadField, runSalesbot } from "../_shared/kommo.ts";

import { normalizeLoose } from "./text.ts";

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

/**
 * Escribe un campo de TEXTO/TEXTAREA de un lead. Para campos con opciones
 * predefinidas (select/radiobutton) usá patchEntityFieldTyped: este helper
 * manda `value` y un select lo acepta con 200 sin guardar nada.
 */
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
export type KommoEnumLite = { id: number; value: string };
export type KommoFieldDef = KommoFieldLite & { type: string; enums: KommoEnumLite[] };

/**
 * Trae la definición COMPLETA de los custom fields de leads o contacts: tipo y
 * enums incluidos. Necesario para escribir campos `select`, que no aceptan un
 * string cualquiera — hay que mandar el enum_id de una opción existente.
 * 204 = sin campos.
 */
export async function fetchEntityFieldDefs(
  entity: "leads" | "contacts",
  kommoDomain: string,
  kommoToken: string
): Promise<KommoFieldDef[]> {
  const url = `https://${kommoDomain}/api/v4/${entity}/custom_fields?limit=250`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${kommoToken}` },
  });
  if (res.status === 204) return [];
  if (!res.ok) {
    throw new Error(`fetch ${entity} fields: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    _embedded?: {
      custom_fields?: Array<{
        id: number;
        name: string;
        type?: string;
        enums?: Array<{ id: number; value: string }> | null;
      }>;
    };
  };
  return (json._embedded?.custom_fields ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type ?? "text",
    enums: (f.enums ?? []).map((e) => ({ id: e.id, value: e.value })),
  }));
}

/**
 * Asigna (o reasigna) el RESPONSABLE de un lead en Kommo.
 * Throws si la respuesta no es OK.
 */
export async function assignLeadResponsible(
  kommoLeadId: number,
  responsibleUserId: number,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ responsible_user_id: responsibleUserId }),
  });
  if (!res.ok) {
    throw new Error(`assign responsible: ${res.status} ${await res.text()}`);
  }
}

/**
 * Resuelve el valor a escribir en un campo según su TIPO.
 *   - campo con enums (select/radiobutton/multiselect) → hay que mandar enum_id.
 *     Mandar `value` en un select es la forma SILENCIOSA de que Kommo acepte el
 *     PATCH con 200 y no guarde nada. Devuelve null si la opción no existe.
 *   - campo de texto → value saneado (Kommo trunca desde el primer emoji).
 */
export function resolveFieldValue(
  def: KommoFieldDef,
  value: string
): { values: Array<Record<string, unknown>>; written: string } | null {
  if (def.enums.length > 0) {
    const target = normalizeLoose(value);
    const hit = def.enums.find((e) => normalizeLoose(e.value) === target);
    if (!hit) return null;
    return { values: [{ enum_id: hit.id }], written: hit.value };
  }
  const written = sanitizeForKommoField(value);
  return { values: [{ value: written }], written };
}

/**
 * Escribe un custom field de un LEAD o un CONTACTO resolviendo el tipo del campo.
 *
 * `def` es la definición ya resuelta (ver fetchEntityFieldDefs) para que el
 * llamador cachee la lista y no pida los campos en cada mensaje. Devuelve lo que
 * efectivamente se escribió. Throws si la opción no existe: es un error de
 * configuración y hay que verlo, no tragarlo.
 */
export async function patchEntityFieldTyped(
  entity: "leads" | "contacts",
  entityId: number,
  def: KommoFieldDef,
  value: string,
  kommoDomain: string,
  kommoToken: string
): Promise<string> {
  const resolved = resolveFieldValue(def, value);
  if (!resolved) {
    throw new Error(
      `campo "${def.name}": la opción "${value}" no existe (opciones: ${def.enums
        .map((e) => e.value)
        .join(", ")})`
    );
  }
  const url = `https://${kommoDomain}/api/v4/${entity}/${entityId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      custom_fields_values: [{ field_id: def.id, values: resolved.values }],
    }),
  });
  if (!res.ok) {
    throw new Error(`patch ${entity} field "${def.name}": ${res.status} ${await res.text()}`);
  }
  return resolved.written;
}

/** Azúcar para el caso más común: escribir un campo del LEAD. */
export function patchLeadFieldTyped(
  kommoLeadId: number,
  def: KommoFieldDef,
  value: string,
  kommoDomain: string,
  kommoToken: string
): Promise<string> {
  return patchEntityFieldTyped("leads", kommoLeadId, def, value, kommoDomain, kommoToken);
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
