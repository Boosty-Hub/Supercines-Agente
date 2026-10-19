// Edge Function: sync-pipelines
//
// Mantiene al día la copia local de los pipelines/etapas de Kommo (que dibuja
// el tablero del inbox) y rellena kommo_pipeline_id / kommo_stage_id de los
// leads que ya existían antes de la migración 0061.
//
// Se invoca desde:
//   - pg_cron, cada 10 min (job `sync-pipelines`, migración 0061). Es el camino
//     automático: tras el deploy, el backfill avanza solo hasta quedar 'done'.
//   - el botón "Sincronizar" del inbox (POST /api/inbox/sync) para no esperar.
//
// Qué hace en cada invocación:
//   1. Refresca pipelines + etapas (UNA llamada a Kommo) → sync_kommo_pipelines().
//      Kommo no avisa por webhook cuando se crea/renombra una etapa: esta es la
//      única forma de enterarse. Mínimo 30 s entre refrescos EN TODA la cuenta:
//      el freno vive en la base (claim_kommo_pipelines_refresh), no en memoria,
//      así que vale entre instancias.
//   2. Reclama el backfill con claim_kommo_backfill y recorre /api/v4/leads por
//      páginas, aplicando solo lo que cambió. Es reanudable (cursor persistido
//      tras cada página) y respeta el rate limit de Kommo (ver
//      _shared/backfill-positions.ts). QUIEN DECIDE es la base, no el caller:
//        · un recorrido en curso se retoma, jamás retrocede, aunque llegue `restart`;
//        · `restart` solo se acepta con el recorrido 'done' y pasados 15 min
//          (COOLDOWN) desde su último movimiento; antes responde «cooldown»;
//        · al terminar un recorrido completo, los leads que no aparecieron son solo
//          CANDIDATOS a inexistentes: la paginación por offset (Kommo no ofrece
//          cursor por id) se corre si borran un lead durante la lectura y uno
//          vivo puede saltarse. Se verifican POR ID en Kommo (filter[id][], lotes
//          de 100): los que existen se aplican y solo los que Kommo confirma
//          ausentes se marcan (leads.kommo_missing_at). «Confirma» = segunda
//          lectura en lotes chicos con un CONTROL POSITIVO (un lead que sí existe) en
//          el mismo pedido: si el control no vuelve, la respuesta no se usa para marcar
//          (_shared/reconcile-leads.ts).
//        · con el recorrido ya 'done', los candidatos que quedaron sin verificar (tope
//          por pasada, lotes sin control, falta de tiempo) se siguen verificando por
//          tandas en cada invocación, con un lease propio (claim_kommo_missing_verify,
//          0090) y SIN reiniciar ni rebobinar el recorrido.
//   3. Huecos: los leads que nacieron sin pipeline (el webhook de su alta no lo
//      traía) se completan pidiendo a Kommo SOLO esos ids (≤ 200 por pasada). No
//      reabre ni recorre todo Kommo, no tiene enfriamiento de 1 h: 1 lead sin
//      pipeline cuesta 1 pedido.
//
// Idempotente: correrla N veces converge al mismo estado. Dos invocaciones
// simultáneas nunca recorren Kommo a la vez (lease en la base).
//
// Respuesta rápida (invariante 2 del CLAUDE.md): el refresco de pipelines es
// una sola llamada y se responde con su resultado; el recorrido de leads, que
// puede tardar, va en EdgeRuntime.waitUntil.
//
// verify_jwt = false (config.toml; el cron y el panel no mandan JWT de usuario)
// pero con GATE: exige el header x-internal-secret (_shared/auth.ts), el secreto
// interno de bajo privilegio guardado en `_app_secrets` (0061). pg_cron lo manda
// desde trigger_sync_pipelines() y POST /api/inbox/sync lo manda desde el
// servidor tras validar la sesión. Sin él: 401 genérico.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { authorizeInternal } from "../_shared/auth.ts";
import { loadConfig } from "../_shared/config.ts";
import {
  fetchLeadsByIds,
  fetchLeadsPositionsPage,
  fetchPipelinesFull,
  KOMMO_IDS_PER_REQUEST,
} from "../_shared/kommo.ts";
import { LeaseLostError, runPositionsBackfill } from "../_shared/backfill-positions.ts";
import { reconcileLeadIds, type ReconcileDeps } from "../_shared/reconcile-leads.ts";
import { interpretClaim, type ClaimDecision, type ClaimRow } from "../_shared/backfill-claim.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

const JOB = "lead_positions";
/** Lease del backfill: más largo que el presupuesto, para que un worker vivo no lo pierda. */
const LEASE_SECONDS = 150;
/** Cuánto puede correr una invocación recorriendo leads. */
const BUDGET_MS = 100_000;
/** ~4 req/s: Kommo permite ~7 por cuenta y se comparten con webhook/agente/panel. */
const PAUSE_MS = 250;
/** Mínimo entre refrescos de pipelines, para toda la cuenta (lo aplica la base). */
const PIPELINES_MIN_INTERVAL_SECONDS = 30;
/** Un reinicio manual solo se acepta pasado este tiempo desde el último movimiento del recorrido. */
const RESTART_COOLDOWN_SECONDS = 15 * 60;
/** Candidatos a inexistentes que se verifican al cerrar un recorrido (los demás quedan para la próxima pasada). */
const MISSING_CANDIDATES_LIMIT = 5000;
/** Candidatos que se verifican por invocación con el recorrido ya 'done'. */
const MISSING_VERIFY_LIMIT = 1500;
/** Tiempo máximo de una verificación por id (cierre de recorrido o pasada con 'done'). */
const VERIFY_BUDGET_MS = 100_000;
/**
 * Plazo de TODA la invocación para empezar pedidos de verificación (recorrido + cierre +
 * huecos), bajo el wall clock de una Edge Function (~400 s) con margen para el último pedido
 * (reintentos de 429 incluidos). Se fija al recibir la request.
 */
const INVOCATION_BUDGET_MS = 280_000;
let invocationDeadline = Date.now() + INVOCATION_BUDGET_MS;
/** Ids por pedido en la confirmación de ausentes, contando el control positivo. */
const CONFIRM_BATCH_SIZE = 25;
/** Huecos (leads sin pipeline) que se completan por pasada. */
const GAP_LIMIT = 200;

type PipelinesResult =
  | { ok: true; stages: number; skipped?: "recent" }
  | { ok: false; error: string };

async function syncPipelines(domain: string, token: string): Promise<PipelinesResult> {
  try {
    // El freno es atómico en la base: si otra instancia refrescó hace < 30 s,
    // no se le pregunta nada a Kommo.
    const { data: won, error: claimErr } = await supabase.rpc("claim_kommo_pipelines_refresh", {
      p_min_interval_seconds: PIPELINES_MIN_INTERVAL_SECONDS,
    });
    if (claimErr) return { ok: false, error: `claim_kommo_pipelines_refresh: ${claimErr.message}` };
    if (won !== true) return { ok: true, stages: 0, skipped: "recent" };

    const pipelines = await fetchPipelinesFull(domain, token);
    const { data, error } = await supabase.rpc("sync_kommo_pipelines", { p_pipelines: pipelines });
    if (error) return { ok: false, error: `sync_kommo_pipelines: ${error.message}` };
    return { ok: true, stages: Number(data ?? 0) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Reclama el backfill (la base decide) y devuelve qué hacer. Rápido: solo una RPC. */
async function claimBackfill(restart: boolean): Promise<ClaimDecision> {
  const { data, error } = await supabase.rpc("claim_kommo_backfill", {
    p_job: JOB,
    p_lease_seconds: LEASE_SECONDS,
    p_restart: restart,
    p_cooldown_seconds: RESTART_COOLDOWN_SECONDS,
  });
  if (error) throw new Error(`claim_kommo_backfill: ${error.message}`);
  return interpretClaim((data as ClaimRow[] | null)?.[0]);
}

/** Reconciliación por id contra Kommo (candidatos a inexistentes y huecos). */
function reconcileDeps(domain: string, token: string, heartbeat?: () => Promise<void>): ReconcileDeps {
  return {
    heartbeat,
    fetchByIds: (ids) => fetchLeadsByIds(domain, token, ids),
    controlCandidates: async () => {
      const { data, error } = await supabase.rpc("kommo_missing_control_ids", { p_limit: 10 });
      if (error) throw new Error(`kommo_missing_control_ids: ${error.message}`);
      return ((data ?? []) as Array<number | string>).map(Number);
    },
    apply: async (leads, readAtMs) => {
      const { data, error } = await supabase.rpc("apply_kommo_lead_positions", {
        p_leads: leads,
        p_read_at: new Date(readAtMs).toISOString(),
      });
      if (error) throw new Error(`apply_kommo_lead_positions: ${error.message}`);
      return Number(data ?? 0);
    },
    markMissing: async (ids) => {
      const { data, error } = await supabase.rpc("mark_kommo_leads_missing", { p_ids: ids });
      if (error) throw new Error(`mark_kommo_leads_missing: ${error.message}`);
      return Number(data ?? 0);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** Completa por id los leads sin pipeline (sin recorrer Kommo). Devuelve el resultado o null si no hay huecos. */
async function fillGaps(domain: string, token: string) {
  const { data, error } = await supabase.rpc("kommo_gap_lead_ids", { p_limit: GAP_LIMIT });
  if (error) throw new Error(`kommo_gap_lead_ids: ${error.message}`);
  const ids = ((data ?? []) as Array<number | string>).map(Number);
  if (ids.length === 0) return null;
  return await reconcileLeadIds(ids, reconcileDeps(domain, token), {
    batchSize: KOMMO_IDS_PER_REQUEST,
    confirmBatchSize: CONFIRM_BATCH_SIZE,
    pauseMs: PAUSE_MS,
    deadlineMs: verifyDeadline(),
  });
}

/**
 * Renueva el lease del recorrido como dueño; LeaseLostError si otro lo tomó. Un error puntual
 * de la RPC se tolera, pero tras LEASE_RENEW_MAX_ERRORS seguidos se corta: sin renovar, el
 * lease vence y otro worker (o un reinicio) podría tomar el recorrido mientras se verifica.
 */
const LEASE_RENEW_MAX_ERRORS = 3;
function leaseRenewer(leaseToken: string) {
  let errors = 0;
  return async () => {
    const { data: renewed, error: leaseErr } = await supabase.rpc("renew_kommo_backfill_lease", {
      p_job: JOB,
      p_token: leaseToken,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (leaseErr) {
      console.warn("sync-pipelines: no se pudo renovar el lease:", leaseErr.message);
      if (++errors >= LEASE_RENEW_MAX_ERRORS) throw new LeaseLostError("no se pudo renovar el lease");
      return;
    }
    errors = 0;
    if (renewed !== true) throw new LeaseLostError();
  };
}

/** Plazo de una verificación: VERIFY_BUDGET_MS, sin pasar el plazo de toda la invocación. */
function verifyDeadline(): number {
  return Math.min(Date.now() + VERIFY_BUDGET_MS, invocationDeadline);
}

/** Candidatos a inexistentes del último recorrido completo (no los marca: hay que verificarlos). */
async function missingCandidates(limit: number): Promise<number[]> {
  const { data, error } = await supabase.rpc("kommo_missing_candidates", { p_job: JOB, p_limit: limit });
  if (error) throw new Error(`kommo_missing_candidates: ${error.message}`);
  return ((data ?? []) as Array<number | string>).map(Number);
}

/**
 * Recorrido ya 'done': verifica por id una tanda de los candidatos que quedaron pendientes,
 * sin reiniciar ni rebobinar el recorrido. Lease propio sobre la fila del recorrido
 * (claim_kommo_missing_verify, 0090): dos invocaciones no verifican a la vez y un reinicio
 * no puede vaciar lo «visto» mientras tanto. Devuelve null si no le tocaba.
 */
async function verifyPendingMissing(domain: string, token: string) {
  const { data: leaseToken, error } = await supabase.rpc("claim_kommo_missing_verify", {
    p_job: JOB,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error(`claim_kommo_missing_verify: ${error.message}`);
  if (!leaseToken) return null; // otro worker lo tiene, o el recorrido no está 'done'
  try {
    const ids = await missingCandidates(MISSING_VERIFY_LIMIT);
    if (ids.length === 0) return { checked: 0 };
    return await reconcileLeadIds(ids, reconcileDeps(domain, token, leaseRenewer(String(leaseToken))), {
      batchSize: KOMMO_IDS_PER_REQUEST,
      confirmBatchSize: CONFIRM_BATCH_SIZE,
      pauseMs: PAUSE_MS,
      deadlineMs: verifyDeadline(),
    });
  } finally {
    // Solo suelta el lease propio (token); si se perdió, no toca el del otro.
    const { error: relErr } = await supabase.rpc("release_kommo_missing_verify", {
      p_job: JOB,
      p_token: String(leaseToken),
    });
    if (relErr) console.warn("sync-pipelines: no se pudo soltar el lease de verificación:", relErr.message);
  }
}

/** Recorre Kommo desde el cursor reclamado. Va en segundo plano. */
async function runBackfill(domain: string, token: string, from: NonNullable<ClaimDecision["run"]>) {
  return await runPositionsBackfill(
    from,
    {
      fetchPage: (page) => fetchLeadsPositionsPage(domain, token, page),
      apply: async (leads, readAtMs) => {
        const { data, error: applyErr } = await supabase.rpc("apply_kommo_lead_positions", {
          p_leads: leads,
          p_read_at: new Date(readAtMs).toISOString(),
        });
        if (applyErr) throw new Error(`apply_kommo_lead_positions: ${applyErr.message}`);
        return Number(data ?? 0);
      },
      finalize: async () => {
        // Candidatos = no aparecieron en el recorrido. NO se marcan: se verifican por id.
        const ids = await missingCandidates(MISSING_CANDIDATES_LIMIT);
        // La verificación por id puede durar más que el lease: se renueva tras cada lote,
        // SOLO como dueño (lease_token). Si la base lo rechaza, otro worker reclamó el
        // recorrido: se para (LeaseLostError) en vez de extenderle el lease ajeno.
        // Con tope de tiempo: lo que no se llegue a confirmar sigue candidato y lo
        // verifica la pasada con el recorrido 'done' (verifyPendingMissing).
        const r = await reconcileLeadIds(ids, reconcileDeps(domain, token, leaseRenewer(from.leaseToken)), {
          batchSize: KOMMO_IDS_PER_REQUEST,
          confirmBatchSize: CONFIRM_BATCH_SIZE,
          pauseMs: PAUSE_MS,
          deadlineMs: verifyDeadline(),
        });
        if (r.suspicious) console.warn(`sync-pipelines: lotes de candidatos sin control positivo en la respuesta de Kommo: no se marcan (${r.unconfirmed} quedan candidatos)`);
        console.log("sync-pipelines candidatos al cerrar:", JSON.stringify(r));
        return r.marked;
      },
      // Guarda como dueño del lease (save_kommo_backfill_progress, 0061): 'running' lo
      // renueva; pending/failed/done lo sueltan. false = otro worker es el dueño → para.
      save: async (p) => {
        const { data: own, error: saveErr } = await supabase.rpc("save_kommo_backfill_progress", {
          p_job: JOB,
          p_token: from.leaseToken,
          p_status: p.status,
          p_next_page: p.nextPage,
          p_scanned: p.scanned,
          p_updated: p.updated,
          p_error: p.error ?? null,
          p_lease_seconds: LEASE_SECONDS,
        });
        if (saveErr) throw new Error(`save_kommo_backfill_progress: ${saveErr.message}`);
        if (own !== true) throw new LeaseLostError();
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    { budgetMs: BUDGET_MS, pauseMs: PAUSE_MS },
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const denied = await authorizeInternal(req, supabase);
  if (denied) return denied;

  invocationDeadline = Date.now() + INVOCATION_BUDGET_MS;
  try {
    const cfg = await loadConfig(supabase);
    const domain = cfg.get("KOMMO_API_DOMAIN");
    const token = cfg.get("KOMMO_ACCESS_TOKEN");
    // Sin Kommo conectado todavía (deploy nuevo antes del wizard /setup): no es
    // un error. El cron vuelve a intentar en 10 min.
    if (!domain || !token) {
      return json({ ok: true, skipped: "kommo_not_configured", backfill: { state: "kommo_not_configured" } });
    }

    const pipelines = await syncPipelines(domain, token);
    // `restart` es solo una PETICIÓN (la manda el servidor del panel con
    // «Sincronizar»): la base la concede o no (enfriamiento, recorrido en curso).
    const body = await req.json().catch(() => ({}));
    const restart = (body as { restart?: unknown })?.restart === true;

    const decision = await claimBackfill(restart);

    // El trabajo contra Kommo puede tardar: va en segundo plano y esta respuesta
    // sale ya, con el refresco de pipelines y el estado del backfill.
    // Huecos DESPUÉS del recorrido / la verificación: el lease recién reclamado no se gasta
    // esperando (el primer guardado lo renueva) y los huecos usan el tiempo que quede.
    const gapsStep = async () => {
      try {
        const gaps = await fillGaps(domain, token);
        if (gaps) console.log("sync-pipelines huecos:", JSON.stringify(gaps));
      } catch (e) {
        console.error("sync-pipelines huecos:", e);
      }
    };
    const mainStep = async () => {
      if (!decision.run) {
        // Recorrido terminado: seguir verificando candidatos pendientes, sin reiniciarlo.
        if (decision.state !== "idle" && decision.state !== "cooldown") return;
        try {
          const v = await verifyPendingMissing(domain, token);
          if (v) console.log("sync-pipelines candidatos pendientes:", JSON.stringify(v));
        } catch (e) {
          console.error("sync-pipelines candidatos pendientes:", e);
        }
        return;
      }
      try {
        const r = await runBackfill(domain, token, decision.run);
        console.log("sync-pipelines backfill:", JSON.stringify(r));
      } catch (e) {
        console.error("sync-pipelines backfill:", e);
      }
    };
    const background = (async () => {
      try {
        await mainStep();
      } finally {
        await gapsStep();
      }
    })();
    // @ts-ignore: EdgeRuntime existe en Supabase
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(background);
    } else {
      await background; // fallback local/test
    }

    return json(
      {
        ok: pipelines.ok,
        pipelines,
        backfill: { state: decision.state, retry_after_seconds: decision.retryAfterSeconds },
      },
      202,
    );
  } catch (err) {
    console.error("sync-pipelines error:", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
