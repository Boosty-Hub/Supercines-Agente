// _shared/kommo.ts
// Helpers reutilizables para interactuar con la API de Kommo CRM.
// Copiados verbatim de publish-to-kommo/index.ts para evitar duplicación.
//
// Uso:
//   import { patchLeadField, runSalesbot } from "../_shared/kommo.ts";

import { normalizeLoose } from "./text.ts";
import { calcularEtiquetasNuevas, type EtiquetaExistente } from "./crm-tags.ts";

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
export function sanitizeKommoFieldValue(input: string): string {
  const out: string[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x200d || cp === 0x20e3) continue; // selector de variación / ZWJ / keycap huérfanos
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

/** Nombre histórico de SuperCines; mismo comportamiento. */
export const sanitizeForKommoField = sanitizeKommoFieldValue;

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
  const safe = sanitizeKommoFieldValue(value);
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
          values: [{ value: sanitizeKommoFieldValue(value) }],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`patch contact: ${res.status} ${await res.text()}`);
  }
}

/**
 * Agrega una nota interna (note_type "common", texto plano, NO visible para el
 * cliente) a un lead de Kommo. Usada por `agregar_nota` y por `transferir_asesor`
 * (ahí es la pieza que sobrevive aunque el movimiento de etapa falle — ver
 * `runCrmTool` en generate-response/index.ts). Sanitiza con
 * `sanitizeKommoFieldValue` por la misma razón que los custom fields: no hay
 * garantía de que el endpoint de notas escape mejor que la columna utf8mb3 que
 * causó la truncación silenciosa documentada arriba, y no cuesta nada ser
 * conservador acá. Throws si !OK.
 */
export async function addLeadNote(
  kommoLeadId: number,
  text: string,
  kommoDomain: string,
  kommoToken: string
): Promise<void> {
  const url = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}/notes`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    // La API espera un ARREGLO de notas aunque sea una sola.
    body: JSON.stringify([{ note_type: "common", params: { text: sanitizeKommoFieldValue(text) } }]),
  });
  if (!res.ok) {
    throw new Error(`add lead note: ${res.status} ${await res.text()}`);
  }
}

/**
 * Agrega etiquetas (tags) a un lead de forma ADITIVA: lee las existentes,
 * calcula con `calcularEtiquetasNuevas` (_shared/crm-tags.ts, puro y probado)
 * cuáles faltan, y hace UN solo PATCH con la unión — Kommo reemplaza el set
 * COMPLETO de `_embedded.tags` en cada PATCH, así que mandar solo las nuevas
 * borraría las que el lead ya tenía. No-op (ni siquiera pega el PATCH) si
 * todas las candidatas ya existían. Throws si !OK.
 */
export async function addLeadTags(
  kommoLeadId: number,
  candidatas: string[],
  kommoDomain: string,
  kommoToken: string
): Promise<{ added: string[] }> {
  const base = `https://${kommoDomain}/api/v4/leads/${kommoLeadId}`;
  const getRes = await fetch(base, {
    headers: { Authorization: `Bearer ${kommoToken}` },
  });
  if (!getRes.ok) {
    throw new Error(`add lead tags (get): ${getRes.status} ${await getRes.text()}`);
  }
  const lead = (await getRes.json()) as { _embedded?: { tags?: EtiquetaExistente[] } };
  const existing = lead._embedded?.tags ?? [];
  const nuevas = calcularEtiquetasNuevas(existing, candidatas);
  if (nuevas.length === 0) return { added: [] };
  const tags = [
    ...existing.map((t) => ({ id: t.id })),
    ...nuevas.map((name) => ({ name })),
  ];
  const patchRes = await fetch(base, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${kommoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ _embedded: { tags } }),
  });
  if (!patchRes.ok) {
    throw new Error(`add lead tags (patch): ${patchRes.status} ${await patchRes.text()}`);
  }
  return { added: nuevas };
}

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
  return flattenPipelines(await fetchPipelinesFull(kommoDomain, kommoToken));
}

/** Pipelines con orden, tipo y color: el formato que espera sync_kommo_pipelines (0061). */
export type KommoPipelineFull = {
  id: number;
  name: string;
  sort: number;
  is_main: boolean;
  is_archive: boolean;
  statuses: Array<{ id: number; name: string; sort: number; type: number; color: string | null }>;
};

export async function fetchPipelinesFull(
  kommoDomain: string,
  kommoToken: string
): Promise<KommoPipelineFull[]> {
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
        sort?: number;
        is_main?: boolean;
        is_archive?: boolean;
        _embedded?: {
          statuses?: Array<{ id: number; name: string; sort?: number; type?: number; color?: string }>;
        };
      }>;
    };
  };
  return (json._embedded?.pipelines ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    sort: p.sort ?? 0,
    is_main: p.is_main === true,
    is_archive: p.is_archive === true,
    statuses: (p._embedded?.statuses ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      sort: s.sort ?? 0,
      type: s.type ?? 0,
      color: s.color ?? null,
    })),
  }));
}

export function flattenPipelines(pipelines: KommoPipelineFull[]): KommoStageLite[] {
  const out: KommoStageLite[] = [];
  for (const p of pipelines) {
    for (const s of p.statuses) {
      out.push({ id: s.id, name: s.name, pipelineId: p.id, pipelineName: p.name });
    }
  }
  return out;
}

/** Posición de un lead tal como la informa GET /api/v4/leads. */
export type KommoLeadPosition = { id: number; status_id: number; pipeline_id: number };

export class KommoHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "KommoHttpError";
  }
}

/** Tope de reintentos ante 429 y espera por defecto si Kommo no manda Retry-After. */
const KOMMO_MAX_429_RETRIES = 4;
const KOMMO_DEFAULT_RETRY_MS = 1000;

export type KommoLeadsRead = {
  leads: KommoLeadPosition[];
  hasMore: boolean;
  /**
   * Instante (ms) en que se PIDIÓ la lectura, antes de enviarla: lo que Kommo
   * devuelve vale a esa hora. Es el `p_read_at` de apply_kommo_lead_positions, para
   * que una lectura lenta no pise un webhook más nuevo.
   */
  readAtMs: number;
};

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * GET /api/v4/leads con el manejo común: 204 = vacío; 429 espera (Retry-After si
 * viene) y reintenta hasta KOMMO_MAX_429_RETRIES (Kommo permite ~7 req/s por
 * cuenta, compartidos con el webhook, el agente y el panel); el resto de los
 * errores salen como KommoHttpError para que el caller decida.
 */
async function fetchLeadsList(
  url: string,
  label: string,
  kommoToken: string,
  sleep: (ms: number) => Promise<void>
): Promise<KommoLeadsRead> {
  const readAtMs = Date.now();
  for (let intento = 0; ; intento++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${kommoToken}` } });
    if (res.status === 204) return { leads: [], hasMore: false, readAtMs };
    if (res.status === 429 && intento < KOMMO_MAX_429_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await res.body?.cancel();
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : KOMMO_DEFAULT_RETRY_MS * (intento + 1));
      continue;
    }
    if (!res.ok) {
      throw new KommoHttpError(res.status, `fetch leads ${label}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      _embedded?: { leads?: Array<{ id: number; status_id?: number; pipeline_id?: number }> };
      _links?: { next?: unknown };
    };
    const leads: KommoLeadPosition[] = [];
    for (const l of json._embedded?.leads ?? []) {
      if (typeof l.id === "number" && typeof l.status_id === "number" && typeof l.pipeline_id === "number") {
        leads.push({ id: l.id, status_id: l.status_id, pipeline_id: l.pipeline_id });
      }
    }
    return { leads, hasMore: Boolean(json._links?.next), readAtMs };
  }
}

/**
 * Una página de GET /api/v4/leads (id, etapa y pipeline de cada lead), ordenada
 * por id. OJO: la paginación es por offset (`page=N`) y Kommo NO ofrece cursor por
 * id (solo `filter[id][]` y rangos por fecha): si se borra un lead mientras se
 * recorre, las páginas se corren y un lead vivo puede saltarse. Por eso nadie debe
 * declarar «no existe» a un lead por no verlo acá: se verifica por id con
 * fetchLeadsByIds.
 */
export function fetchLeadsPositionsPage(
  kommoDomain: string,
  kommoToken: string,
  page: number,
  limit = 250,
  sleep: (ms: number) => Promise<void> = sleepMs
): Promise<KommoLeadsRead> {
  return fetchLeadsList(
    `https://${kommoDomain}/api/v4/leads?limit=${limit}&page=${page}&order[id]=asc`,
    `page ${page}`,
    kommoToken,
    sleep
  );
}

/** Máximo de ids por pedido: filter[id][] va en la URL (100 ids ≈ 3 KB, bajo el límite de 8 KB). */
export const KOMMO_IDS_PER_REQUEST = 100;

/**
 * Los leads de Kommo con esos ids (hasta KOMMO_IDS_PER_REQUEST). Los que no
 * vuelven en la respuesta NO existen en Kommo (borrados): 204 si ninguno existe.
 */
export function fetchLeadsByIds(
  kommoDomain: string,
  kommoToken: string,
  ids: number[],
  sleep: (ms: number) => Promise<void> = sleepMs
): Promise<KommoLeadsRead> {
  if (ids.length === 0) return Promise.resolve({ leads: [], hasMore: false, readAtMs: Date.now() });
  if (ids.length > KOMMO_IDS_PER_REQUEST) {
    throw new Error(`fetchLeadsByIds: máximo ${KOMMO_IDS_PER_REQUEST} ids por pedido (llegaron ${ids.length})`);
  }
  const qs = ids.map((id) => `filter[id][]=${encodeURIComponent(String(id))}`).join("&");
  return fetchLeadsList(
    `https://${kommoDomain}/api/v4/leads?limit=${KOMMO_IDS_PER_REQUEST}&${qs}`,
    `by ids (${ids.length})`,
    kommoToken,
    sleep
  );
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
  const written = sanitizeKommoFieldValue(value);
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

export type KommoCustomFieldValue = { field_id: number; values: Array<{ value: unknown }> };

export type KommoLeadRaw = {
  id: number;
  status_id: number;
  pipeline_id: number;
  responsible_user_id: number | null;
  created_at: number;
  updated_at: number;
  custom_fields_values: KommoCustomFieldValue[] | null;
  contactId: number | null;
};

const LEADS_PAGE_SIZE = 250;
const LEADS_PAGE_SAFETY_CAP = 40; // 40 * 250 = 10.000 leads por pipeline, de sobra

/**
 * Pagina TODOS los leads de un pipeline creados desde `sinceUnix` (epoch
 * segundos), con el contacto principal embebido (solo el id — Kommo no
 * expande sus custom fields acá, para eso ver `fetchContactsByIds`).
 * Throws si alguna página responde !OK.
 */
export async function fetchLeadsByPipelineSince(
  pipelineId: number,
  sinceUnix: number,
  kommoDomain: string,
  kommoToken: string
): Promise<KommoLeadRaw[]> {
  const out: KommoLeadRaw[] = [];
  for (let page = 1; page <= LEADS_PAGE_SAFETY_CAP; page++) {
    const url =
      `https://${kommoDomain}/api/v4/leads` +
      `?filter[pipeline_id]=${pipelineId}` +
      `&filter[created_at][from]=${sinceUnix}` +
      `&with=contacts&limit=${LEADS_PAGE_SIZE}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${kommoToken}` } });
    if (res.status === 204) break; // sin más resultados
    if (!res.ok) {
      throw new Error(`fetch leads (pipeline ${pipelineId}, page ${page}): ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      _embedded?: {
        leads?: Array<{
          id: number;
          status_id: number;
          pipeline_id: number;
          responsible_user_id?: number | null;
          created_at: number;
          updated_at: number;
          custom_fields_values: KommoCustomFieldValue[] | null;
          _embedded?: { contacts?: Array<{ id: number; is_main?: boolean }> };
        }>;
      };
    };
    const leads = json._embedded?.leads ?? [];
    for (const l of leads) {
      const contacts = l._embedded?.contacts ?? [];
      const main = contacts.find((c) => c.is_main) ?? contacts[0];
      out.push({
        id: l.id,
        status_id: l.status_id,
        pipeline_id: l.pipeline_id,
        responsible_user_id: l.responsible_user_id ?? null,
        created_at: l.created_at,
        updated_at: l.updated_at,
        custom_fields_values: l.custom_fields_values,
        contactId: main?.id ?? null,
      });
    }
    if (leads.length < LEADS_PAGE_SIZE) break; // última página
  }
  return out;
}

export type KommoContactLite = { id: number; name: string | null; email: string | null };

const CONTACT_EMAIL_FIELD_ID = 115308;
const CONTACTS_BATCH_SIZE = 250;

/**
 * Trae nombre + email (custom field "Email") de un lote de contactos por id.
 * Pagina en lotes de 250 ids (límite de la API). Throws si alguna página
 * responde !OK (204 = sin resultados para ese lote, no es error).
 */
export async function fetchContactsByIds(
  ids: number[],
  kommoDomain: string,
  kommoToken: string
): Promise<Map<number, KommoContactLite>> {
  const out = new Map<number, KommoContactLite>();
  const uniqueIds = Array.from(new Set(ids));
  for (let i = 0; i < uniqueIds.length; i += CONTACTS_BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + CONTACTS_BATCH_SIZE);
    if (batch.length === 0) continue;
    const qs = batch.map((id) => `filter[id][]=${id}`).join("&");
    const url = `https://${kommoDomain}/api/v4/contacts?${qs}&limit=${CONTACTS_BATCH_SIZE}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${kommoToken}` } });
    if (res.status === 204) continue;
    if (!res.ok) {
      throw new Error(`fetch contacts batch: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      _embedded?: {
        contacts?: Array<{
          id: number;
          name?: string | null;
          custom_fields_values: KommoCustomFieldValue[] | null;
        }>;
      };
    };
    for (const c of json._embedded?.contacts ?? []) {
      const emailField = (c.custom_fields_values ?? []).find((f) => f.field_id === CONTACT_EMAIL_FIELD_ID);
      const email = emailField?.values?.[0]?.value;
      out.set(c.id, {
        id: c.id,
        name: c.name ?? null,
        email: typeof email === "string" ? email : null,
      });
    }
  }
  return out;
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

/**
 * Devuelve los IDs de eventos `outgoing_chat_message` recientes que pertenecen a un
 * lead. Kommo NO permite filtrar estos eventos por entidad (filter[entity]=lead los
 * excluye; filter[entity_id] da 400), así que pedimos los últimos N por TIPO a nivel
 * cuenta y matcheamos `entity_id` del lado nuestro. Fail-open: ante cualquier error
 * devuelve un set vacío (el verificador lo interpreta como "sin novedad todavía").
 */
export async function fetchOutgoingEventIds(
  kommoLeadId: number,
  kommoDomain: string,
  kommoToken: string,
  limit = 100
): Promise<Set<string>> {
  const url = `https://${kommoDomain}/api/v4/events?filter[type]=outgoing_chat_message&order[created_at]=desc&limit=${limit}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${kommoToken}` } });
    if (!res.ok) return new Set();
    const json = await res.json();
    // deno-lint-ignore no-explicit-any
    const events: any[] = json?._embedded?.events ?? [];
    return new Set(
      events
        .filter((e) => String(e.entity_id) === String(kommoLeadId))
        .map((e) => String(e.id))
    );
  } catch {
    return new Set();
  }
}

/**
 * Verifica que el salesbot HAYA ENTREGADO un mensaje al canal del lead.
 *
 * `POST /api/v2/salesbot/run` responde 202 `{"success":true}` SIEMPRE (fire-and-forget;
 * no valida que el bot exista ni que entregue), así que esa respuesta NO prueba el
 * envío. La única señal real de entrega es un evento `outgoing_chat_message` NUEVO del
 * lead. `baseline` = los IDs de eventos salientes que ya existían ANTES de disparar el
 * bot (con fetchOutgoingEventIds); hacemos poll hasta que aparezca un ID que no estaba,
 * o hasta agotar `timeoutMs`. Devuelve `true` si se detectó la entrega.
 *
 * Caveat: `outgoing_chat_message` también se dispara con envíos MANUALES — si un humano
 * contesta dentro de la ventana daría un falso positivo (raro, asumible). Para el
 * problema real (NO-entrega) la señal es confiable.
 */
export async function verifyOutgoingDelivery(
  kommoLeadId: number,
  baseline: Set<string>,
  kommoDomain: string,
  kommoToken: string,
  timeoutMs = 12000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Primer chequeo tras un respiro corto; luego cada ~3.5s hasta el deadline.
  let delay = 2500;
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = 3500;
    const current = await fetchOutgoingEventIds(kommoLeadId, kommoDomain, kommoToken);
    for (const id of current) {
      if (!baseline.has(id)) return true;
    }
  }
  return false;
}
