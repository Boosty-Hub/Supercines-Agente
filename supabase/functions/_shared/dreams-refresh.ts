// _shared/dreams-refresh.ts
// Decisión PURA de cómo se escribe un learning de Dreams que puede refrescar un dream ya
// registrado (dreams-run). Sin I/O para poder probarla.
//
// Por qué (revisión de c833dd4): un refresco de un dream ACTIVO se escribía activo aunque la
// política DREAMS_AUTO_ACTIVATE no lo activaría (un learning nuevo con la misma severidad sí
// habría quedado pendiente) y el original se BORRABA para siempre. Además el destino se
// decidía con la lista leída al empezar: si el operador lo borraba o aprobaba mientras
// tanto, el refresco lo resucitaba o lo duplicaba. Reglas:
//  - destino ACTIVO y la política NO activaría este learning → se escribe PENDIENTE con
//    `refreshes: <id del activo>`; el activo no se toca. Recién al APROBARLO en /dreams se
//    reemplaza el original (web: lib/dreams-refresh.ts), que va a /dreams-archive/.
//  - destino ACTIVO y la política lo activaría → se escribe activo y el original se MUEVE a
//    /dreams-archive/ (nunca se borra) + alerta: cambió una regla que el agente ya aplicaba.
//  - destino PENDIENTE → estado según la política; el pendiente viejo se reemplaza (nunca
//    llegó al agente). Si ese pendiente ya refrescaba un activo, el nuevo hereda `refreshes`
//    y queda pendiente: el activo solo cambia con la aprobación del operador.
//  - El destino se relee por id justo antes de escribir: si ya no existe (el operador lo
//    borró) se descarta; si se movió (aprobado/archivado) se decide con su ubicación ACTUAL.
//  - Topes: MAX_LEARNINGS_PER_RUN learnings y MAX_REFRESHES_PER_RUN refrescos por corrida.

import { parseOccurrences, parseRefreshes } from "./dreams-generation.ts";

export const MAX_LEARNINGS_PER_RUN = 8;
export const MAX_REFRESHES_PER_RUN = 3;

export const refreshesOf = parseRefreshes;

export type StoredDream = { id: string; path: string; content: string };

export type RefreshPlan =
  | { action: "drop"; reason: "refresh_cap" | "target_gone" | "target_archived" }
  | {
    action: "write";
    active: boolean;
    /** Frontmatter `refreshes`: el activo que este pendiente reemplazará al aprobarse. */
    refreshes: string | null;
    /** Qué hacer con un dream anterior DESPUÉS de escribir el nuevo. */
    replace: (StoredDream & { mode: "archive" | "delete" }) | null;
    /** Cambia el contenido de un dream que el agente YA aplicaba → alerta. */
    activeChanged: boolean;
    occurrences: number;
    refreshedFrom: string | null;
  };

const isActivePath = (p: string) => p.startsWith("/dreams/");
const isPendingPath = (p: string) => p.startsWith("/dreams-pending/");

export function toArchivePath(path: string): string {
  return path.replace(/^\/dreams\//, "/dreams-archive/");
}

/** Tope de learnings por corrida, en código (el schema de salida no admite maxItems). */
export function clampLearnings<T>(learnings: unknown): T[] {
  return Array.isArray(learnings) ? (learnings as T[]).slice(0, MAX_LEARNINGS_PER_RUN) : [];
}

export function planLearningWrite(opts: {
  /** Dream al que el modelo dijo que refina (`updates: "D<n>"`), o null si es nuevo. */
  target: { id: string; path: string } | null;
  /** Lectura FRESCA del destino por id (null = ya no existe; undefined si no hay destino). */
  current: StoredDream | null | undefined;
  /** ¿La política DREAMS_AUTO_ACTIVATE activaría este learning si fuera nuevo? */
  policyActive: boolean;
  /** Refrescos ya escritos en esta corrida. */
  refreshesSoFar: number;
  /** Pendiente previo que ya refresca al mismo activo (se reemplaza, no se acumula). */
  pendingRefreshOf?: StoredDream | null;
}): RefreshPlan {
  if (!opts.target) {
    return { action: "write", active: opts.policyActive, refreshes: null, replace: null, activeChanged: false, occurrences: 1, refreshedFrom: null };
  }
  if (opts.refreshesSoFar >= MAX_REFRESHES_PER_RUN) return { action: "drop", reason: "refresh_cap" };
  const cur = opts.current;
  if (!cur) return { action: "drop", reason: "target_gone" };
  const occurrences = parseOccurrences(cur.content) + 1;
  if (isPendingPath(cur.path)) {
    const inherited = parseRefreshes(cur.content);
    return {
      action: "write",
      active: inherited ? false : opts.policyActive,
      refreshes: inherited,
      replace: { ...cur, mode: "delete" },
      activeChanged: false,
      occurrences,
      refreshedFrom: cur.path,
    };
  }
  if (isActivePath(cur.path)) {
    if (opts.policyActive) {
      return { action: "write", active: true, refreshes: null, replace: { ...cur, mode: "archive" }, activeChanged: true, occurrences, refreshedFrom: cur.path };
    }
    const prev = opts.pendingRefreshOf;
    return {
      action: "write",
      active: false,
      refreshes: cur.id,
      replace: prev ? { ...prev, mode: "delete" } : null,
      activeChanged: false,
      occurrences,
      refreshedFrom: cur.path,
    };
  }
  return { action: "drop", reason: "target_archived" };
}
