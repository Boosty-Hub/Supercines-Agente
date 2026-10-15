// lib/provision/ensure-signup-lock.ts — cierra y VERIFICA el registro público cuando corre el
// actualizador (migrate / updates), para que TODO cliente existente lo cierre al actualizar.
//
// INVARIANT: no importa runtime-config.ts ni service.ts (lo usan rutas de /api/provision).
//
// Un proyecto nuevo nace con el registro público abierto; los clientes desplegados antes de este
// módulo nunca lo cerraron (solo el /first-run nuevo lo hace). Como cada paso de migrate es una
// request, el cierre se hace a lo sumo una vez cada TTL por instancia (la Management API tiene
// límite de tasa) y solo se memoriza si quedó verificado.

import { lockPublicSignup, type SignupLockResult } from "./signup-lock.ts";

export const SIGNUP_RECHECK_MS = 10 * 60 * 1000;

const lastOk = new Map<string, number>();

/** Solo para tests. */
export function resetSignupLockMemo(): void {
  lastOk.clear();
}

export async function ensureSignupLocked(
  ref: string,
  token: string,
  deps: { now?: () => number; lock?: typeof lockPublicSignup } = {}
): Promise<SignupLockResult> {
  const now = (deps.now ?? Date.now)();
  const last = lastOk.get(ref);
  if (last !== undefined && now - last < SIGNUP_RECHECK_MS) return { ok: true };
  const r = await (deps.lock ?? lockPublicSignup)(ref, token);
  if (r.ok) lastOk.set(ref, now);
  else console.warn(`[provision] no se pudo cerrar el registro público: ${r.error}`);
  return r;
}
