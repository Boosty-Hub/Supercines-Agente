// _shared/dreams-lease.ts
// Lease de la fase de ANÁLISIS de dreams-run (migración 0098, claim_dreams_run /
// release_dreams_run). El cron daily y el weekly coinciden el domingo 03:00 y el botón
// «Correr ahora» puede caer encima: sin lease, dos análisis leían la misma lista de dreams y
// escribían cada uno su versión (duplicados, refrescos cruzados). La base decide quién analiza.

/** Más que el wall clock de una Edge Function (400 s): un worker vivo nunca lo pierde. */
export const DREAMS_LEASE_SECONDS = 600;

export type DreamsClaim =
  | { kind: "acquired"; token: string }
  | { kind: "busy" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export function interpretDreamsClaim(res: { data: unknown; error: { code?: string; message?: string } | null }): DreamsClaim {
  if (res.error) {
    // 0098 sin aplicar: se corre sin lease, como antes (el despliegue aplica migraciones primero).
    if (res.error.code === "PGRST202") return { kind: "unavailable" };
    return { kind: "error", message: res.error.message ?? String(res.error.code ?? "error") };
  }
  return typeof res.data === "string" && res.data ? { kind: "acquired", token: res.data } : { kind: "busy" };
}
