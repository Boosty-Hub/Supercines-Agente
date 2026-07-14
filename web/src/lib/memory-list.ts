// Helper server-side para listar y leer memories del master Memory Store.
// Usa raw fetch (lib/anthropic-managed) en vez del SDK oficial, que devuelve
// "401 (no body)" en el runtime de Netlify.
import { configValue } from "@/lib/runtime-config";
import {
  listMemories,
  retrieveMemory,
  createMemory,
  deleteMemory,
} from "@/lib/anthropic-managed";

export type DreamMeta = {
  id: string;
  path: string;
  contentSizeBytes: number;
  category?: string;
  vertical?: string;
  title?: string;
  date?: string;
  period?: string;
};

async function masterCreds(): Promise<{ apiKey: string; storeId: string }> {
  const apiKey = await configValue("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
  const storeId = await configValue("ANTHROPIC_MEMORY_MASTER_ID");
  if (!storeId) throw new Error("ANTHROPIC_MEMORY_MASTER_ID not configured");
  return { apiKey, storeId };
}

export async function listDreams(): Promise<DreamMeta[]> {
  const { apiKey, storeId } = await masterCreds();
  const items = await listMemories(apiKey, storeId, "/dreams/");
  return items
    .map((it) => ({
      id: it.id,
      path: it.path,
      contentSizeBytes: it.content_size_bytes ?? 0,
    }))
    .sort((a, b) => (a.path < b.path ? 1 : -1));
}

// Dreams pendientes de aprobación: viven bajo /dreams-pending/, que el agente
// NO lee (su prompt solo apunta a /dreams/). Aprobar = mover a /dreams/.
export async function listPendingDreams(): Promise<DreamMeta[]> {
  const { apiKey, storeId } = await masterCreds();
  const items = await listMemories(apiKey, storeId, "/dreams-pending/");
  return items
    .map((it) => ({
      id: it.id,
      path: it.path,
      contentSizeBytes: it.content_size_bytes ?? 0,
    }))
    .sort((a, b) => (a.path < b.path ? 1 : -1));
}

// Aprueba un dream pendiente: lo re-crea bajo /dreams/ (mismo nombre) y borra
// el original de /dreams-pending/. Desde ese momento el agente lo adopta.
export async function approveDream(id: string): Promise<{ path: string } | null> {
  const { apiKey, storeId } = await masterCreds();
  const mem = await retrieveMemory(apiKey, storeId, id);
  if (!mem || !mem.path.startsWith("/dreams-pending/")) return null;
  const activePath = mem.path.replace(/^\/dreams-pending\//, "/dreams/");
  await createMemory(apiKey, storeId, activePath, mem.content ?? "");
  await deleteMemory(apiKey, storeId, id);
  return { path: activePath };
}

export async function readDream(id: string): Promise<{ path: string; content: string } | null> {
  const { apiKey, storeId } = await masterCreds();
  const mem = await retrieveMemory(apiKey, storeId, id);
  return mem ? { path: mem.path, content: mem.content ?? "" } : null;
}

export async function createDream(path: string, content: string): Promise<string> {
  const { apiKey, storeId } = await masterCreds();
  const mem = await createMemory(apiKey, storeId, path, content);
  return mem.id;
}

export async function deleteDream(id: string): Promise<boolean> {
  const { apiKey, storeId } = await masterCreds();
  return deleteMemory(apiKey, storeId, id);
}

export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.+)$/i);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}
