// server-only: reads Kommo creds from runtime_config and calls the Kommo REST API.
// Used by /api/kommo/pipelines and /api/filters/generate.
import { configValues } from "@/lib/runtime-config";

export type KommoStage = { id: number; name: string; color: string | null };
export type KommoPipeline = { id: number; name: string; statuses: KommoStage[] };

/**
 * Fetches pipelines + their statuses (stages) from Kommo.
 * Returns { configured:false } when Kommo creds are not set yet, so callers can
 * render a "connect Kommo first" state instead of erroring.
 */
export async function fetchPipelines(): Promise<{
  configured: boolean;
  pipelines: KommoPipeline[];
}> {
  const { KOMMO_API_DOMAIN: domain, KOMMO_ACCESS_TOKEN: token } = await configValues([
    "KOMMO_API_DOMAIN",
    "KOMMO_ACCESS_TOKEN",
  ]);
  if (!domain || !token) return { configured: false, pipelines: [] };

  const res = await fetch(`https://${domain}/api/v4/leads/pipelines`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Kommo pipelines: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    _embedded?: {
      pipelines?: Array<{
        id: number;
        name: string;
        _embedded?: { statuses?: Array<{ id: number; name: string; color?: string }> };
      }>;
    };
  };
  const pipelines = (json._embedded?.pipelines ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    statuses: (p._embedded?.statuses ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color ?? null,
    })),
  }));
  return { configured: true, pipelines };
}

export type KommoUser = { id: number; name: string; email: string | null };

/**
 * Fetches the account's users (vendedores) from Kommo, to map
 * responsible_user_id → name in the follow-up "run_user_ids" selector.
 * Returns { configured:false } when Kommo creds are not set yet.
 */
export async function fetchUsers(): Promise<{
  configured: boolean;
  users: KommoUser[];
}> {
  const { KOMMO_API_DOMAIN: domain, KOMMO_ACCESS_TOKEN: token } = await configValues([
    "KOMMO_API_DOMAIN",
    "KOMMO_ACCESS_TOKEN",
  ]);
  if (!domain || !token) return { configured: false, users: [] };

  const res = await fetch(`https://${domain}/api/v4/users?limit=250`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Kommo users: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    _embedded?: { users?: Array<{ id: number; name: string; email?: string }> };
  };
  const users = (json._embedded?.users ?? []).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email ?? null,
  }));
  return { configured: true, users };
}

export type KommoFieldEntity = "leads" | "contacts";
export type KommoField = {
  id: number;
  name: string;
  type: string; // text | numeric | checkbox | select | multiselect | date | url | ...
  code: string | null;
  entity: KommoFieldEntity;
  enums: { id: number; value: string }[];
};

/**
 * Fetches custom fields for leads and contacts from Kommo, so the dashboard can
 * let the operator pick a field BY NAME instead of typing a numeric id.
 * { configured:false } when Kommo creds are not set.
 */
export async function fetchCustomFields(): Promise<{
  configured: boolean;
  leads: KommoField[];
  contacts: KommoField[];
}> {
  const { KOMMO_API_DOMAIN: domain, KOMMO_ACCESS_TOKEN: token } = await configValues([
    "KOMMO_API_DOMAIN",
    "KOMMO_ACCESS_TOKEN",
  ]);
  if (!domain || !token) return { configured: false, leads: [], contacts: [] };

  async function fetchEntity(entity: KommoFieldEntity): Promise<KommoField[]> {
    const res = await fetch(`https://${domain}/api/v4/${entity}/custom_fields?limit=250`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    // 204 = sin custom fields para esa entidad.
    if (res.status === 204) return [];
    if (!res.ok) throw new Error(`Kommo ${entity} fields: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as {
      _embedded?: {
        custom_fields?: Array<{
          id: number;
          name: string;
          type: string;
          code?: string | null;
          enums?: Array<{ id: number; value: string }> | null;
        }>;
      };
    };
    return (json._embedded?.custom_fields ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      code: f.code ?? null,
      entity,
      enums: (f.enums ?? []).map((e) => ({ id: e.id, value: e.value })),
    }));
  }

  const [leads, contacts] = await Promise.all([fetchEntity("leads"), fetchEntity("contacts")]);
  return { configured: true, leads, contacts };
}

/**
 * Crea un campo custom en Kommo (leads/contacts) y devuelve el campo creado.
 * Lo usa el editor de seguimiento para "crear campo al vuelo": si el operador
 * necesita un campo que no existe, lo crea desde el dashboard y queda matcheado
 * al instante — sin ir a la consola de Kommo ni mantener una tabla de mapeo aparte.
 */
export async function createCustomField(
  entity: KommoFieldEntity,
  name: string,
  type: string = "text"
): Promise<KommoField> {
  const { KOMMO_API_DOMAIN: domain, KOMMO_ACCESS_TOKEN: token } = await configValues([
    "KOMMO_API_DOMAIN",
    "KOMMO_ACCESS_TOKEN",
  ]);
  if (!domain || !token) throw new Error("Kommo no está conectado todavía.");

  // Kommo espera un array de campos a crear.
  const res = await fetch(`https://${domain}/api/v4/${entity}/custom_fields`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify([{ name, type }]),
  });
  if (!res.ok) {
    throw new Error(`Kommo crear campo (${entity}): ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    _embedded?: {
      custom_fields?: Array<{
        id: number;
        name: string;
        type: string;
        code?: string | null;
        enums?: Array<{ id: number; value: string }> | null;
      }>;
    };
  };
  const created = json._embedded?.custom_fields?.[0];
  if (!created) throw new Error("Kommo no devolvió el campo creado.");
  return {
    id: created.id,
    name: created.name,
    type: created.type,
    code: created.code ?? null,
    entity,
    enums: (created.enums ?? []).map((e) => ({ id: e.id, value: e.value })),
  };
}

/**
 * Etapa ACTUAL de un lead consultada en vivo a Kommo (GET /leads/{id}).
 * Devuelve null si no está configurado o falla (fail-open) — el caller decide
 * el fallback (p.ej. el kommo_stage_id persistido).
 */
export async function fetchLeadStage(
  kommoLeadId: number
): Promise<{ statusId: number; pipelineId: number | null } | null> {
  try {
    const { KOMMO_API_DOMAIN: domain, KOMMO_ACCESS_TOKEN: token } = await configValues([
      "KOMMO_API_DOMAIN",
      "KOMMO_ACCESS_TOKEN",
    ]);
    if (!domain || !token) return null;
    const res = await fetch(`https://${domain}/api/v4/leads/${kommoLeadId}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { status_id?: number; pipeline_id?: number };
    return typeof j.status_id === "number"
      ? { statusId: j.status_id, pipelineId: j.pipeline_id ?? null }
      : null;
  } catch {
    return null;
  }
}
