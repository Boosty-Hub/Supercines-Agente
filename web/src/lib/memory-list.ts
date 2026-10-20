// Helper server-side para listar y leer memories del master Memory Store.
// Usa raw fetch (lib/anthropic-managed) en vez del SDK oficial, que devuelve
// "401 (no body)" en el runtime de Netlify.
import { configValue } from "@/lib/runtime-config";
import { callInternalFunction } from "@/lib/internal-call";
import {
  AnthropicHttpError,
  listMemories,
  retrieveMemory,
  retrieveMemoryStrict,
  createMemory,
  deleteMemory,
} from "@/lib/anthropic-managed";
import { planApprove, refreshesOf } from "@/lib/dreams-refresh";

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

// Dreams pendientes de aprobación: viven bajo /dreams-pending/, que no entran
// al digest del agente (solo se consolida /dreams/). Aprobar = mover a /dreams/.
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
// Si el pendiente es el REFRESCO de un activo (frontmatter `refreshes`, ver
// lib/dreams-refresh.ts), ese activo se mueve a /dreams-archive/ (nunca se borra sin copia).
export async function approveDream(id: string): Promise<{ path: string } | null> {
  const { apiKey, storeId } = await masterCreds();
  const mem = await retrieveMemory(apiKey, storeId, id);
  if (!mem || !mem.path.startsWith("/dreams-pending/")) return null;
  const pending = { id: mem.id ?? id, path: mem.path, content: mem.content ?? "" };
  const targetId = refreshesOf(pending.content);
  // Lectura estricta: un error transitorio NO se toma por «ya no existe» (aprobaría sin
  // archivar el activo y quedarían dos reglas vigentes).
  const t = targetId ? await retrieveMemoryStrict(apiKey, storeId, targetId) : null;
  const target = t ? { id: t.id ?? targetId!, path: t.path, content: t.content ?? "" } : null;
  const steps = planApprove(pending, target);
  if (!steps) return null;
  let activePath = pending.path.replace(/^\/dreams-pending\//, "/dreams/");
  for (const step of steps) {
    if (step.op === "archive") {
      try {
        await createMemory(apiKey, storeId, step.path, step.content);
      } catch (err) {
        // 409 = ya estaba archivado (reintento de una aprobación a medias): seguir.
        if (!(err instanceof AnthropicHttpError && err.status === 409)) throw err;
      }
    } else if (step.op === "create") {
      await createMemory(apiKey, storeId, step.path, step.content);
      activePath = step.path;
    } else {
      await deleteMemory(apiKey, storeId, step.id);
    }
  }
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

/**
 * Borra un dream (activo o pendiente). Devuelve si era ACTIVO (/dreams/): solo un
 * activo forma parte del digest, así que solo ahí hace falta reconsolidarlo. Si no
 * se puede saber (la lectura previa falló), se asume activo: una reconstrucción de
 * más cuesta una llamada; una de menos deja vigente una regla que el operador acaba
 * de borrar.
 */
export async function deleteDream(id: string): Promise<{ wasActive: boolean }> {
  const { apiKey, storeId } = await masterCreds();
  const mem = await retrieveMemory(apiKey, storeId, id).catch(() => null);
  await deleteMemory(apiKey, storeId, id);
  return { wasActive: mem ? mem.path.startsWith("/dreams/") : true };
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

/**
 * Dispara la reconsolidación del digest de dreams (runtime_config.DREAMS_DIGEST,
 * lo construye dreams-run en modo digest_only) tras una mutación del dashboard
 * (aprobar / borrar / importar). Sin esto, un dream borrado seguiría vigente en el
 * digest hasta la próxima corrida.
 *
 * Fail-open y NO fire-and-forget a ciegas: en el runtime serverless un fetch sin
 * await puede congelarse antes de salir. dreams-run responde 202 de inmediato (el
 * trabajo corre en su waitUntil), así que esperar la respuesta cuesta milisegundos.
 * Si falla, la mutación NO se revierte: la próxima corrida de dreams-run repara el
 * digest.
 */
export async function triggerDigestRebuild(): Promise<void> {
  try {
    const res = await callInternalFunction("dreams-run", { digest_only: true }, { timeoutMs: 8000 });
    if (!res.ok) console.warn("triggerDigestRebuild:", res.status);
  } catch (err) {
    console.warn("triggerDigestRebuild:", err instanceof Error ? err.message : String(err));
  }
}
