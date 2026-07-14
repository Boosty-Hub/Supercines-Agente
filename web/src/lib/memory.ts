// Memory client — habla con Anthropic Memory Stores (Managed Agents beta API).
// Los stores se crearon vía scripts/setup-memory-stores.mjs con los nombres
// configurados en MEMORY_STORE_MASTER_NAME / MEMORY_STORE_LEADS_NAME. En el
// código usamos labels semánticos "master" / "leads" — el ID real viene
// de ANTHROPIC_MEMORY_MASTER_ID / ANTHROPIC_MEMORY_LEADS_ID.
//
// La búsqueda semántica NO se hace desde código host: el agente Sonnet, ya
// dentro del contenedor en su sesión CMA, monta /mnt/memory/<store>/ y hace
// grep/glob/read. Acá solo escribimos y listamos.

import { configValue } from "@/lib/runtime-config";
import { createMemory, deleteMemory, listMemories } from "@/lib/anthropic-managed";

export type StoreName = "master" | "leads";

export type MemoryInsert = {
  storeName: StoreName;
  leadId?: string | null;
  sourceKind: string;            // 'voice_sample' | 'kb_document' | 'conversation' | etc.
  sourceId?: string | null;      // uuid del registro maestro en Supabase
  content: string;
  metadata?: Record<string, unknown>;
};

export type MemoryListItem = {
  id: string;
  path: string;
  contentSizeBytes?: number;
};

export interface MemoryClient {
  insertMany(items: MemoryInsert[]): Promise<string[]>;
  deleteByIds(storeName: StoreName, memoryIds: string[]): Promise<number>;
  listByPathPrefix(opts: {
    storeName: StoreName;
    pathPrefix: string;
    limit?: number;
  }): Promise<MemoryListItem[]>;
}

function requireStoreId(storeIds: Record<StoreName, string | undefined>, name: StoreName): string {
  const id = storeIds[name];
  if (!id) {
    throw new Error(
      `Memory store ${name} no configurado. Corré el wizard de setup o configurá ANTHROPIC_MEMORY_${name.toUpperCase()}_ID.`
    );
  }
  return id;
}

function pathFor(item: MemoryInsert, chunkIndex: number): string {
  // leads: subdirectorio por lead — /{lead_id}/{sourceKind}_{n}.md
  if (item.storeName === "leads") {
    if (!item.leadId) throw new Error("leadId requerido para store 'leads'");
    const slug = (item.sourceKind ?? "memo").replace(/[^a-z0-9_-]/gi, "_");
    return `/${item.leadId}/${slug}_${chunkIndex}.md`;
  }
  // master: /{sourceKind}/{sourceId}_{n}.md
  // sourceKind puede llevar `/` para anidar (ej: "voice/chat_export")
  const slug = (item.sourceKind ?? "memo")
    .replace(/[^a-z0-9_/-]/gi, "_")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
  const id = item.sourceId ?? "anon";
  return `/${slug}/${id}_${chunkIndex}.md`;
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  if (/^[A-Za-z0-9_/.: -]+$/.test(s) && !/^\s|\s$/.test(s)) return s;
  return JSON.stringify(s);
}

function frontmatter(item: MemoryInsert, chunkIndex: number): string {
  const meta = {
    source_kind: item.sourceKind,
    source_id: item.sourceId ?? null,
    lead_id: item.leadId ?? null,
    chunk_index: chunkIndex,
    ...(item.metadata ?? {}),
  };
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${yamlScalar(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

class AnthropicMemoryClient implements MemoryClient {
  private apiKey: string;
  private storeIds: Record<StoreName, string | undefined>;

  constructor(apiKey: string, storeIds: Record<StoreName, string | undefined>) {
    this.apiKey = apiKey;
    this.storeIds = storeIds;
  }

  async insertMany(items: MemoryInsert[]): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const storeId = requireStoreId(this.storeIds, item.storeName);
      const chunkIndex = Number(item.metadata?.chunk_index ?? i);
      const path = pathFor(item, chunkIndex);
      const content = frontmatter(item, chunkIndex) + item.content;
      const mem = await createMemory(this.apiKey, storeId, path, content);
      ids.push(mem.id);
    }
    return ids;
  }

  async deleteByIds(storeName: StoreName, memoryIds: string[]): Promise<number> {
    if (memoryIds.length === 0) return 0;
    const storeId = requireStoreId(this.storeIds, storeName);
    let deleted = 0;
    for (const id of memoryIds) {
      if (await deleteMemory(this.apiKey, storeId, id)) deleted++;
    }
    return deleted;
  }

  async listByPathPrefix({
    storeName,
    pathPrefix,
    limit = 100,
  }: {
    storeName: StoreName;
    pathPrefix: string;
    limit?: number;
  }): Promise<MemoryListItem[]> {
    const storeId = requireStoreId(this.storeIds, storeName);
    const items = await listMemories(this.apiKey, storeId, pathPrefix, limit);
    return items.slice(0, limit).map((it) => ({
      id: it.id,
      path: it.path,
      contentSizeBytes: it.content_size_bytes,
    }));
  }
}

// Async factory: resolves credentials via runtime-config (DB-first / env-fallback)
// before constructing the client. Returns a new client per call — callers should
// hold the reference for the duration of a request.
export async function getMemoryClient(): Promise<MemoryClient> {
  const apiKey = await configValue("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing — set it in runtime_config or .env.local");
  const storeIds: Record<StoreName, string | undefined> = {
    master: await configValue("ANTHROPIC_MEMORY_MASTER_ID"),
    leads: await configValue("ANTHROPIC_MEMORY_LEADS_ID"),
  };
  return new AnthropicMemoryClient(apiKey, storeIds);
}
