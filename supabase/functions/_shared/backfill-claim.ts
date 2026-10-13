// _shared/backfill-claim.ts
// Traduce la fila que devuelve claim_kommo_backfill() (migración 0061) al estado
// que entienden sync-pipelines y el panel. La DECISIÓN (¿se reinicia? ¿hay
// enfriamiento? ¿hay otro worker?) la toma la base, atómicamente; acá solo se
// nombra el resultado. Sin I/O: se testea sin red ni base.

export type ClaimRow = {
  outcome: string;
  status: string | null;
  next_page: number | null;
  scanned: number | null;
  updated: number | null;
  retry_after_seconds: number | null;
  /** Dueño del lease (solo en claimed/restarted): se presenta para renovar y guardar progreso. */
  lease_token: string | null;
};

/**
 * - started:     recorrido nuevo desde la página 1 (reinicio aceptado).
 * - continuing:  se retoma el recorrido en curso desde su cursor (nunca rebobina).
 * - busy:        otro worker tiene el lease: «ya está sincronizando».
 * - cooldown:    el reinicio se pidió demasiado pronto (`retryAfterSeconds`).
 * - idle:        terminado y sin nada que hacer.
 * - unavailable: no hay fila del job (migración incompleta).
 */
export type BackfillState = "started" | "continuing" | "busy" | "cooldown" | "idle" | "unavailable";

export type ClaimDecision = {
  state: BackfillState;
  /**
   * Desde dónde correr y con qué token de dueño del lease; null si esta invocación NO
   * debe recorrer Kommo.
   */
  run: { nextPage: number; scanned: number; updated: number; leaseToken: string } | null;
  retryAfterSeconds: number | null;
};

export function interpretClaim(row: ClaimRow | undefined | null): ClaimDecision {
  if (!row) return { state: "unavailable", run: null, retryAfterSeconds: null };
  switch (row.outcome) {
    case "restarted":
    case "claimed":
      // Sin token no hay forma de renovar ni guardar como dueño: no se recorre (una base
      // sin la columna lease_token es una migración incompleta).
      if (!row.lease_token) return { state: "unavailable", run: null, retryAfterSeconds: null };
      return {
        state: row.outcome === "restarted" ? "started" : "continuing",
        run: {
          nextPage: row.next_page ?? 1,
          scanned: row.scanned ?? 0,
          updated: row.updated ?? 0,
          leaseToken: row.lease_token,
        },
        retryAfterSeconds: null,
      };
    case "busy":
      return { state: "busy", run: null, retryAfterSeconds: null };
    case "cooldown":
      return { state: "cooldown", run: null, retryAfterSeconds: row.retry_after_seconds ?? null };
    case "done":
      return { state: "idle", run: null, retryAfterSeconds: null };
    default:
      return { state: "unavailable", run: null, retryAfterSeconds: null };
  }
}
