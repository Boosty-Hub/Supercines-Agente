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
//      única forma de enterarse. Mínimo 30 s entre refrescos por instancia.
//   2. Si el backfill no está 'done' (o quedaron leads sin pipeline y pasó más
//      de 1 h desde que terminó, o el panel pidió `restart`), reclama el lease (claim_kommo_backfill) y
//      recorre /api/v4/leads por páginas, aplicando solo lo que cambió. Es
//      reanudable (cursor persistido tras cada página) y respeta el rate limit
//      de Kommo (ver _shared/backfill-positions.ts).
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
import { runPositionsBackfill, type BackfillProgress } from "../_shared/backfill-positions.ts";

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
const PIPELINES_MIN_INTERVAL_MS = 30_000;

let lastPipelinesSyncAt = 0;

type PipelinesResult =
  | { ok: true; stages: number; skipped?: "recent" }
  | { ok: false; error: string };

async function syncPipelines(domain: string, token: string): Promise<PipelinesResult> {
  if (Date.now() - lastPipelinesSyncAt < PIPELINES_MIN_INTERVAL_MS) {
    return { ok: true, stages: 0, skipped: "recent" };
  }
  try {
    const pipelines = await fetchPipelinesFull(domain, token);
    const { data, error } = await supabase.rpc("sync_kommo_pipelines", { p_pipelines: pipelines });
    if (error) return { ok: false, error: `sync_kommo_pipelines: ${error.message}` };
    lastPipelinesSyncAt = Date.now();
    return { ok: true, stages: Number(data ?? 0) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Un backfill terminado se reabre si quedaron leads sin pipeline, pero no más de 1 vez por hora. */
const GAP_REOPEN_MS = 60 * 60_000;

/**
 * ¿Hay que reabrir un backfill 'done'? Leads que nacieron después de que
 * terminó (el webhook de su alta no traía pipeline) quedarían sin ubicar para
 * siempre. Los leads borrados en Kommo también cuentan como hueco: por eso el
 * tope de 1 vez por hora, para no recorrer Kommo cada 10 min por ellos.
 */
async function hasPositionGaps(): Promise<boolean> {
  const { data: state } = await supabase
    .from("kommo_backfill")
    .select("status, finished_at")
    .eq("job", JOB)
    .maybeSingle();
  if (!state || state.status !== "done") return false;
  if (state.finished_at && Date.now() - Date.parse(state.finished_at as string) < GAP_REOPEN_MS) return false;
  const { data: gap } = await supabase.from("leads").select("id").is("kommo_pipeline_id", null).limit(1);
  return (gap?.length ?? 0) > 0;
}

async function runBackfill(
  domain: string,
  token: string,
  forceRestart: boolean
): Promise<BackfillProgress | "not_claimed"> {
  const { data: claimed, error } = await supabase.rpc("claim_kommo_backfill", {
    p_job: JOB,
    p_lease_seconds: LEASE_SECONDS,
    p_restart: forceRestart || (await hasPositionGaps()),
  });
  if (error) throw new Error(`claim_kommo_backfill: ${error.message}`);
  const row = (claimed as Array<{ next_page: number; scanned: number; updated: number }> | null)?.[0];
  if (!row) return "not_claimed"; // ya está 'done' o hay otro worker con el lease

  return await runPositionsBackfill(
    { nextPage: row.next_page, scanned: row.scanned, updated: row.updated },
    {
      fetchPage: (page) => fetchLeadsPositionsPage(domain, token, page),
      apply: async (leads) => {
        const { data, error: applyErr } = await supabase.rpc("apply_kommo_lead_positions", { p_leads: leads });
        if (applyErr) throw new Error(`apply_kommo_lead_positions: ${applyErr.message}`);
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
    // `restart` lo manda SOLO el servidor del panel («Sincronizar»), ya con el
    // secreto interno validado: reconcilia todos los leads contra Kommo.
    const body = await req.json().catch(() => ({}));
    const restart = (body as { restart?: unknown })?.restart === true;

    // El recorrido de leads puede tardar: va en segundo plano y esta respuesta
    // sale ya, con el resultado del refresco de pipelines.
    const backfill = (async () => {
      try {
        const r = await runBackfill(domain, token, restart);
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

    return json({ ok: pipelines.ok, pipelines, backfill: "scheduled" }, 202);
  } catch (err) {
    console.error("sync-pipelines error:", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
