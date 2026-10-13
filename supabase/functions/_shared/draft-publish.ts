// _shared/draft-publish.ts
// Parte pura (sin I/O) de la publicación de drafts en Kommo con reserva por draft
// (migración 0074). La atomicidad la garantiza la base (claim_draft_for_publish,
// mark_draft_publish_sending, recover_dead_draft_publishes — ver
// supabase/tests/draft_publish_claim.sql); acá viven las decisiones que toma
// publish-to-kommo con lo que la base le devuelve, para probarlas sin red ni base.
//
// GARANTÍA DE ENVÍO (lo que el cliente final ve):
//   · A lo sumo UN envío por reserva: solo el dueño del lease publica, y antes de
//     cada salesbot fija la marca write-ahead `publish_sending_at` (si el lease
//     venció o lo tomó otro, la marca falla y NO se envía nada).
//   · Un draft cuya marca existe NUNCA vuelve a `approved`: si el worker muere
//     después de marcar, el mensaje pudo haber salido. Se resuelve verificando en
//     Kommo (resolveInterrupted) → `auto_sent` si apareció el saliente, o `failed`
//     + alerta para que lo mire un humano. Preferimos un mensaje que quizás no
//     llegó (y una alerta) a un mensaje duplicado.
//   · Muerte ANTES de la marca: no se disparó ningún salesbot (escribir el campo de
//     Kommo no le manda nada al cliente) → se reintenta (`approved`), hasta
//     PUBLISH_MAX_ATTEMPTS reservas muertas; después `failed`.

import { stripGuardFlags } from "./outbound.ts";

/** Lease de la reserva. Mayor que el wall clock máximo de una Edge Function (400 s):
 *  cuando vence, el worker está muerto con certeza. */
export const PUBLISH_LEASE_SECONDS = 600;
/** Reservas muertas antes de la marca de envío tras las cuales el draft pasa a failed. */
export const PUBLISH_MAX_ATTEMPTS = 3;
/** Tiempo tras el cual una invocación deja de reservar drafts nuevos (el resto lo
 *  toma el próximo barrido). Cada draft cuesta hasta ~20 s con la verificación. */
export const PUBLISH_RUN_BUDGET_MS = 100_000;
/** Tope de drafts por invocación (mismo orden que el límite histórico de pickPending). */
export const PUBLISH_MAX_PER_RUN = 10;

/** El lease ya no es nuestro (venció o lo recuperó otro worker): NO se envía nada. */
export class LeaseLostError extends Error {
  constructor(public draftId: string) {
    super(`la reserva del draft ${draftId} ya no es de este worker; no se envía`);
    this.name = "LeaseLostError";
  }
}

// ---------------------------------------------------------------------------
// Resolución de un draft interrumpido DESPUÉS de marcar el envío.
// ---------------------------------------------------------------------------

export type InterruptedResolution =
  | { action: "mark_sent"; reason: string }
  | { action: "mark_failed"; reason: string };

/**
 * @param baseline IDs de outgoing_chat_message del lead tomados justo antes del
 *                 salesbot del DM (null = no se tomó: verificación apagada, o murió
 *                 entre la respuesta pública y el DM).
 * @param current  IDs actuales del lead (fetchOutgoingEventIds).
 *
 * NUNCA devuelve «reenviar»: con la marca puesta el mensaje pudo haber salido.
 */
export function resolveInterrupted(
  baseline: readonly string[] | null,
  current: Iterable<string>
): InterruptedResolution {
  if (baseline == null) {
    return {
      action: "mark_failed",
      reason:
        "la publicación se interrumpió después de empezar el envío y no hay foto previa de los mensajes para verificarlo",
    };
  }
  const before = new Set(baseline);
  for (const id of current) {
    if (!before.has(id)) {
      return { action: "mark_sent", reason: "apareció un mensaje saliente nuevo después de la interrupción" };
    }
  }
  return {
    action: "mark_failed",
    reason: "la publicación se interrumpió después de empezar el envío y no se encontró el mensaje saliente",
  };
}

// ---------------------------------------------------------------------------
// Resultado de un draft reservado → fila final (siempre libera la reserva).
// ---------------------------------------------------------------------------

export type DraftOutcome =
  | { kind: "delivered"; verified: boolean; publicBlocked: string | null; recovered?: boolean }
  | { kind: "undelivered"; publicBlocked: string | null; reason: string }
  | { kind: "blocked_dm"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "expired" }
  /** No se pudo ni leer el draft reservado: nada salió → vuelve a `approved`. */
  | { kind: "released"; reason: string }
  | { kind: "lease_lost" };

/** Campos que liberan la reserva. publish_sending_at / publish_claimed_at quedan como auditoría. */
export const RELEASE_LEASE = { publish_owner: null, publish_lease_until: null, publish_baseline: null } as const;

export type FinalPatch = Record<string, unknown> & { status: string };

/**
 * Qué escribir en el draft según el resultado. null = no tocar la fila (lease_lost:
 * ya no es nuestra). El llamador SIEMPRE aplica el patch con la guarda
 * `status = 'publishing' AND publish_owner = <yo>`.
 */
export function finalPatch(
  outcome: DraftOutcome,
  baseMeta: Record<string, unknown>,
  nowIso: string
): FinalPatch | null {
  switch (outcome.kind) {
    case "delivered": {
      const publicMeta = outcome.publicBlocked
        ? {
            guard_blocked: true,
            guard_kind: "internal_leak",
            guard_part: "public_reply",
            guard_reason: outcome.publicBlocked,
            guard_stage: "publish",
          }
        : {};
      return {
        status: "auto_sent",
        sent_at: nowIso,
        ...RELEASE_LEASE,
        agent_metadata: {
          ...stripGuardFlags(baseMeta),
          ...(outcome.verified ? { delivery_verified: true } : {}),
          ...(outcome.recovered ? { delivery_recovered: true } : {}),
          ...publicMeta,
        },
      };
    }
    case "undelivered":
      return {
        status: "failed",
        ...RELEASE_LEASE,
        agent_metadata: { ...baseMeta, delivery_unverified: true, publish_error: outcome.reason },
      };
    case "blocked_dm":
      // Vuelve a revisión humana (el texto suele ser recuperable con una edición).
      return {
        status: "pending",
        ...RELEASE_LEASE,
        agent_metadata: {
          ...stripGuardFlags(baseMeta),
          guard_blocked: true,
          guard_kind: "internal_leak",
          guard_reason: outcome.reason,
          guard_stage: "publish",
        },
      };
    case "error":
      return { status: "failed", ...RELEASE_LEASE, agent_metadata: { ...baseMeta, publish_error: outcome.message } };
    case "expired":
      return {
        status: "rejected",
        ...RELEASE_LEASE,
        agent_metadata: {
          ...baseMeta,
          expired: true,
          expired_reason: "vencido tras pausa: más viejo que answer_max_age_hours",
        },
      };
    case "released":
      return { status: "approved", ...RELEASE_LEASE };
    case "lease_lost":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Bucle de publicación: reserva de a UN draft y lo procesa, hasta agotar la cola,
// el tope o el presupuesto de tiempo. Nunca procesa algo que no reservó.
// ---------------------------------------------------------------------------

export type PublishTally = {
  published: number;
  undelivered: number;
  failed: number;
  expired: number;
  blocked: number;
  released: number;
  lease_lost: number;
  errors: Array<{ draft_id: string; error: string }>;
};

export function emptyTally(): PublishTally {
  return { published: 0, undelivered: 0, failed: 0, expired: 0, blocked: 0, released: 0, lease_lost: 0, errors: [] };
}

export function tallyOutcome(t: PublishTally, draftId: string, o: DraftOutcome): void {
  switch (o.kind) {
    case "delivered":
      t.published++;
      return;
    case "undelivered":
      t.undelivered++;
      t.failed++;
      t.errors.push({ draft_id: draftId, error: o.reason });
      return;
    case "blocked_dm":
      t.blocked++;
      t.failed++;
      t.errors.push({ draft_id: draftId, error: `bloqueado por guard: ${o.reason}` });
      return;
    case "error":
      t.failed++;
      t.errors.push({ draft_id: draftId, error: o.message });
      return;
    case "expired":
      t.expired++;
      return;
    case "released":
      t.released++;
      t.errors.push({ draft_id: draftId, error: o.reason });
      return;
    case "lease_lost":
      t.lease_lost++;
      return;
  }
}

export async function runPublishLoop(deps: {
  /** Reserva atómica de un draft (RPC claim_draft_for_publish). null = cola vacía. */
  claim: () => Promise<string | null>;
  /** Procesa un draft YA reservado y devuelve su resultado (nunca lanza). */
  process: (draftId: string) => Promise<DraftOutcome>;
  /** ¿Se puede seguir? (p. ej. el operador activó el apagado total a mitad). */
  canContinue?: () => Promise<boolean>;
  now?: () => number;
  budgetMs?: number;
  maxDrafts?: number;
}): Promise<PublishTally> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? PUBLISH_RUN_BUDGET_MS;
  const maxDrafts = deps.maxDrafts ?? PUBLISH_MAX_PER_RUN;
  const startedAt = now();
  const tally = emptyTally();
  for (let n = 0; n < maxDrafts; n++) {
    if (now() - startedAt >= budgetMs) break;
    if (deps.canContinue && !(await deps.canContinue())) break;
    const id = await deps.claim();
    if (!id) break;
    tallyOutcome(tally, id, await deps.process(id));
  }
  return tally;
}
