// Aprobar un dream pendiente desde /dreams (approveDream en memory-list.ts), PURO para poder
// probarlo con node --test (imports relativos, sin @/).
//
// Un pendiente puede ser el REFRESCO de un dream activo (frontmatter `refreshes: <id>`, lo
// escribe dreams-run cuando la política DREAMS_AUTO_ACTIVATE no activaría el learning:
// supabase/functions/_shared/dreams-refresh.ts). Aprobarlo reemplaza ese activo, que se MUEVE
// a /dreams-archive/ — nunca se borra sin copia. Orden: primero la copia archivada (si falla,
// nada cambió), después el nuevo activo, después el original y por último el pendiente.

export type StoredDream = { id: string; path: string; content: string };

export type ApproveStep =
  | { op: "archive"; path: string; content: string }
  | { op: "create"; path: string; content: string }
  | { op: "delete"; id: string };

const MEMORY_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Frontmatter `refreshes`: id del dream activo que este pendiente reemplaza al aprobarse. */
export function refreshesOf(content: string): string | null {
  const m = String(content ?? "").match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  // Una clave repetida es un frontmatter adulterado: se rechaza (misma regla que la Edge).
  if (m[1].split("\n").filter((l) => /^refreshes\s*:/.test(l)).length > 1) return null;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^refreshes:\s*(.+)$/);
    if (!kv) continue;
    let v = kv[1].trim();
    try {
      const j = JSON.parse(v);
      if (typeof j === "string") v = j;
    } catch {
      // valor sin comillas
    }
    return MEMORY_ID.test(v) ? v : null;
  }
  return null;
}

export function toArchivePath(path: string): string {
  return path.replace(/^\/dreams\//, "/dreams-archive/");
}

/**
 * Pasos para aprobar `pending`. `target` = lectura fresca del dream que dice refrescar (null si
 * no refresca nada o ya no existe). null si `pending` no es un pendiente.
 */
export function planApprove(pending: StoredDream, target: StoredDream | null): ApproveStep[] | null {
  if (!pending.path.startsWith("/dreams-pending/")) return null;
  const activePath = pending.path.replace(/^\/dreams-pending\//, "/dreams/");
  const create: ApproveStep = { op: "create", path: activePath, content: pending.content };
  const dropPending: ApproveStep = { op: "delete", id: pending.id };
  const replaces = target && target.id !== pending.id && target.path.startsWith("/dreams/") &&
    refreshesOf(pending.content) === target.id;
  if (!replaces) return [create, dropPending];
  const archive: ApproveStep = { op: "archive", path: toArchivePath(target.path), content: target.content };
  const dropOriginal: ApproveStep = { op: "delete", id: target.id };
  return target.path === activePath
    ? [archive, dropOriginal, create, dropPending]
    : [archive, create, dropOriginal, dropPending];
}
