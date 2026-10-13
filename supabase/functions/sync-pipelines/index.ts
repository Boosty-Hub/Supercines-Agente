// Edge Function: sync-pipelines
//
// Mantiene al día la copia local de los pipelines/etapas de Kommo (que dibuja
// el tablero del inbox) y rellena kommo_pipeline_id / kommo_stage_id de los
// leads que ya existían antes de la migración 0065.
//
// Se invoca desde:
//   - pg_cron, cada 10 min (job `sync-pipelines`, migración 0065). Es el camino
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
//        · un 'done' de hace más de 1 h se reabre solo si hay leads sin pipeline
//          que no estén marcados como inexistentes en Kommo;
//        · al terminar un recorrido completo, los leads que Kommo no devolvió se
//          marcan (leads.kommo_missing_at) y dejan de contar como pendientes.
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
// interno de bajo privilegio guardado en `_app_secrets` (0065). pg_cron lo manda
// desde trigger_sync_pipelines() y POST /api/inbox/sync lo manda desde el
// servidor tras validar la sesión. Sin él: 401 genérico.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { authorizeInternal } from "../_shared/auth.ts";
import { loadConfig } from "../_shared/config.ts";
import { fetchLeadsPositionsPage, fetchPipelinesFull } from "../_shared/kommo.ts";
import { runPositionsBackfill } from "../_shared/backfill-positions.ts";
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
/** Un recorrido terminado se reabre por leads sin pipeline como máximo 1 vez por hora. */
const GAP_REOPEN_SECONDS = 60 * 60;

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
    p_reopen_gaps: true,
    p_gap_seconds: GAP_REOPEN_SECONDS,
  });
  if (error) throw new Error(`claim_kommo_backfill: ${error.message}`);
  return interpretClaim((data as ClaimRow[] | null)?.[0]);
}

/** Recorre Kommo desde el cursor reclamado. Va en segundo plano. */
async function runBackfill(domain: string, token: string, from: NonNullable<ClaimDecision["run"]>) {
  return await runPositionsBackfill(
    from,
    {
      fetchPage: (page) => fetchLeadsPositionsPage(domain, token, page),
      apply: async (leads) => {
        const { data, error: applyErr } = await supabase.rpc("apply_kommo_lead_positions", { p_leads: leads });
        if (applyErr) throw new Error(`apply_kommo_lead_positions: ${applyErr.message}`);
        return Number(data ?? 0);
      },
      finalize: async () => {
        const { data, error: markErr } = await supabase.rpc("mark_kommo_missing_leads", { p_job: JOB });
        if (markErr) throw new Error(`mark_kommo_missing_leads: ${markErr.message}`);
        return Number(data ?? 0);
      },
      save: async (p) => {
        const finished = p.status === "done";
        const released = p.status !== "running"; // pending/failed/done sueltan el lease
        const { error: saveErr } = await supabase
          .from("kommo_backfill")
          .update({
            status: p.status,
            next_page: p.nextPage,
            scanned: p.scanned,
            updated: p.updated,
            last_error: p.error ?? null,
            lease_until: released ? null : new Date(Date.now() + LEASE_SECONDS * 1000).toISOString(),
            finished_at: finished ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
          })
          .eq("job", JOB);
        if (saveErr) throw new Error(`kommo_backfill update: ${saveErr.message}`);
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

  try {
    const cfg = await loadConfig(supabase);
    const domain = cfg.get("KOMMO_API_DOMAIN");
    const token = cfg.get("KOMMO_ACCESS_TOKEN");
    // Sin Kommo conectado todavía (deploy nuevo antes del wizard /setup): no es
    // un error. El cron vuelve a intentar en 10 min.
    if (!domain || !token) return json({ ok: true, skipped: "kommo_not_configured" });

    const pipelines = await syncPipelines(domain, token);
    // `restart` es solo una PETICIÓN (la manda el servidor del panel con
    // «Sincronizar»): la base la concede o no (enfriamiento, recorrido en curso).
    const body = await req.json().catch(() => ({}));
    const restart = (body as { restart?: unknown })?.restart === true;

    const decision = await claimBackfill(restart);

    // El recorrido de leads puede tardar: va en segundo plano y esta respuesta
    // sale ya, con el refresco de pipelines y el estado del backfill.
    if (decision.run) {
      const from = decision.run;
      const backfill = (async () => {
        try {
          const r = await runBackfill(domain, token, from);
          console.log("sync-pipelines backfill:", JSON.stringify(r));
        } catch (e) {
          console.error("sync-pipelines backfill:", e);
        }
      })();
      // @ts-ignore: EdgeRuntime existe en Supabase
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(backfill);
      } else {
        await backfill; // fallback local/test
      }
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
