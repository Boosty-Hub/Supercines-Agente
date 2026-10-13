// Interpreta la respuesta de POST /api/agent/sync (puro, testeable).
//
// Un 409 NO es un error de red ni un fallo: es el sistema diciendo «el prompt vivo
// fue editado fuera del dashboard y no lo pisé». Trae el conflicto (con el diff) y la UI
// debe llevar al usuario al panel de resolución, no mostrar el mensaje crudo.

import type { PromptConflict } from "./agent-prompt-sync.ts";

export type SyncOutcome =
  | { kind: "ok" }
  | { kind: "conflict"; conflict: PromptConflict }
  | { kind: "error"; message: string };

export function interpretSyncResponse(status: number, body: unknown): SyncOutcome {
  const b = (body && typeof body === "object" ? body : {}) as {
    ok?: unknown;
    error?: unknown;
    conflict?: unknown;
  };
  if (status === 409 && b.conflict && typeof b.conflict === "object") {
    return { kind: "conflict", conflict: b.conflict as PromptConflict };
  }
  if (status >= 200 && status < 300 && b.ok === true) return { kind: "ok" };
  const message = typeof b.error === "string" && b.error ? b.error : `HTTP ${status}`;
  return { kind: "error", message };
}
