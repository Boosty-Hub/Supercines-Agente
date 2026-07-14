// Raw-fetch client for the Anthropic Managed Agents API (environments, agents,
// memory stores).
//
// WHY NOT THE OFFICIAL SDK: @anthropic-ai/sdk's request wrapper returns a
// spurious "401 (no body)" on Netlify's serverless runtime even for a valid key
// (the same reason key validation was switched to raw fetch). Raw fetch to the
// exact same endpoint works on Netlify. Ground truth captured from the SDK:
//   URL:     https://api.anthropic.com/v1/<resource>?beta=true
//   headers: x-api-key · anthropic-version: 2023-06-01 · anthropic-beta: managed-agents-2026-04-01
//   methods: create = POST /v1/<resource>; update = POST /v1/<resource>/<id>; list = GET /v1/<resource>

const BASE = "https://api.anthropic.com";
const BETA = "managed-agents-2026-04-01";

function authHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETA,
    "content-type": "application/json",
  };
}

/** Error HTTP con status accesible — permite distinguir 404 (no existe) de
 *  401/429/5xx (Anthropic degradado) en los llamadores. */
export class AnthropicHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "AnthropicHttpError";
  }
}

async function call(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}beta=true`, {
    method,
    headers: authHeaders(apiKey),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AnthropicHttpError(
      `Anthropic ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`,
      res.status
    );
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export interface NamedResource {
  id: string;
  name?: string;
  version?: number;
  status?: string;
}

type Resource = "environments" | "agents" | "memory_stores";

/** Find a resource by EXACT name (scans up to 100 — plenty for a single tenant). */
export async function findByName(
  apiKey: string,
  resource: Resource,
  name: string
): Promise<NamedResource | null> {
  const data = await call(apiKey, "GET", `/v1/${resource}?limit=100`);
  const items = Array.isArray((data as { data?: unknown }).data)
    ? ((data as { data: NamedResource[] }).data)
    : [];
  return items.find((x) => x.name === name) ?? null;
}

export async function createEnvironment(apiKey: string, body: unknown): Promise<NamedResource> {
  return (await call(apiKey, "POST", "/v1/environments", body)) as unknown as NamedResource;
}

export async function createAgent(apiKey: string, body: unknown): Promise<NamedResource> {
  return (await call(apiKey, "POST", "/v1/agents", body)) as unknown as NamedResource;
}

export async function updateAgent(apiKey: string, id: string, body: unknown): Promise<NamedResource> {
  return (await call(apiKey, "POST", `/v1/agents/${id}`, body)) as unknown as NamedResource;
}

export async function createMemoryStore(apiKey: string, body: unknown): Promise<NamedResource> {
  return (await call(apiKey, "POST", "/v1/memory_stores", body)) as unknown as NamedResource;
}

export async function retrieveAgent(apiKey: string, id: string): Promise<NamedResource> {
  return (await call(apiKey, "GET", `/v1/agents/${id}`)) as unknown as NamedResource;
}

/** Retrieve por ID: null SOLO si el recurso no existe (404). Cualquier otro
 *  error (401/429/5xx = Anthropic degradado o key inválida) PROPAGA — el
 *  llamador NO debe interpretarlo como "no existe" y crear un duplicado
 *  (eso huérfana el recurso original con todos sus datos). */
export async function retrieveResource(
  apiKey: string,
  resource: Resource,
  id: string
): Promise<NamedResource | null> {
  try {
    return (await call(apiKey, "GET", `/v1/${resource}/${id}`)) as unknown as NamedResource;
  } catch (err) {
    if (err instanceof AnthropicHttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Renombra un recurso en Anthropic. Los agents usan concurrencia optimista
 * (requieren `version`; ante 409 por una escritura concurrente se relee la
 * versión y se reintenta una vez); environments y memory_stores aceptan el
 * name directo. IMPORTANTE: para memory_stores el nombre es también la RUTA
 * de montaje (/mnt/memory/<name>) — quien renombra debe actualizar
 * runtime_config y re-sincronizar el system prompt en la misma operación.
 */
export async function renameResource(
  apiKey: string,
  resource: Resource,
  id: string,
  name: string
): Promise<NamedResource> {
  if (resource === "agents") {
    const doRename = async (): Promise<NamedResource> => {
      const current = await retrieveAgent(apiKey, id);
      return (await call(apiKey, "POST", `/v1/agents/${id}`, {
        version: current.version,
        name,
      })) as unknown as NamedResource;
    };
    try {
      return await doRename();
    } catch (err) {
      if (err instanceof AnthropicHttpError && err.status === 409) return await doRename();
      throw err;
    }
  }
  return (await call(apiKey, "POST", `/v1/${resource}/${id}`, { name })) as unknown as NamedResource;
}

// ─── Memory items (files inside a memory store) ──────────────────────────────

export interface MemoryItem {
  id: string;
  type?: string;
  path: string;
  content?: string;
  content_size_bytes?: number;
}

/** List memory items in a store, optionally filtered by path prefix. Paginates
 *  defensively: if the cursor fields aren't present it just returns the first
 *  page (capped) — never loops forever. */
export async function listMemories(
  apiKey: string,
  storeId: string,
  pathPrefix?: string,
  max = 1000
): Promise<MemoryItem[]> {
  const out: MemoryItem[] = [];
  let afterId = "";
  for (let page = 0; page < 20 && out.length < max; page++) {
    let path = `/v1/memory_stores/${storeId}/memories?limit=100`;
    if (pathPrefix) path += `&path_prefix=${encodeURIComponent(pathPrefix)}`;
    if (afterId) path += `&after_id=${encodeURIComponent(afterId)}`;
    const data = await call(apiKey, "GET", path);
    const items = Array.isArray((data as { data?: unknown }).data)
      ? ((data as { data: MemoryItem[] }).data)
      : [];
    for (const it of items) {
      if (it.type && it.type !== "memory") continue;
      out.push(it);
    }
    const hasMore = Boolean((data as { has_more?: unknown }).has_more);
    const lastId = typeof (data as { last_id?: unknown }).last_id === "string"
      ? (data as { last_id: string }).last_id
      : "";
    if (!hasMore || !lastId || lastId === afterId) break;
    afterId = lastId;
  }
  return out;
}

export async function retrieveMemory(
  apiKey: string,
  storeId: string,
  id: string
): Promise<MemoryItem | null> {
  try {
    return (await call(apiKey, "GET", `/v1/memory_stores/${storeId}/memories/${id}`)) as unknown as MemoryItem;
  } catch {
    return null;
  }
}

export async function createMemory(
  apiKey: string,
  storeId: string,
  path: string,
  content: string
): Promise<MemoryItem> {
  return (await call(apiKey, "POST", `/v1/memory_stores/${storeId}/memories`, {
    path,
    content,
  })) as unknown as MemoryItem;
}

/** Delete a memory item. Returns true on success OR 404 (already gone). */
export async function deleteMemory(
  apiKey: string,
  storeId: string,
  id: string
): Promise<boolean> {
  const res = await fetch(
    `${BASE}/v1/memory_stores/${storeId}/memories/${id}?beta=true`,
    { method: "DELETE", headers: authHeaders(apiKey) }
  );
  if (res.ok || res.status === 404) return true;
  throw new Error(`Anthropic DELETE memory → ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
