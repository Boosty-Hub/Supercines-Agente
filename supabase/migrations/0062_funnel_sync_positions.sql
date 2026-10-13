-- =============================================================
-- 0062_funnel_sync_positions.sql
-- Específica de SuperCines (no existe en el template): acopla kommo-funnel-sync
-- (0058) con el tablero del inbox (0061) para que haya UNA sola fuente de verdad
-- de "en qué pipeline/etapa está cada lead" (leads.kommo_pipeline_id /
-- kommo_stage_id) y no dos recorridos de Kommo que se pisen.
--
-- 1) reconcile_funnel_lead_positions(): kommo-funnel-sync YA lee de Kommo, cada
--    15 min, los leads de los 3 pipelines-sede con su pipeline_id y status_id.
--    En vez de tirar ese dato (o de pedirlo de nuevo), lo vuelca acá. Es la
--    misma regla que apply_kommo_lead_positions() del backfill —delegan las dos en
--    apply_positions_batch() de 0061: UN solo camino de escritura, ordenado por
--    leads.kommo_position_at (solo toca filas que CAMBIAN: cada UPDATE a `leads` dispara un refresco en vivo en los inbox
--    abiertos; y no escribe lead_stage_events: reconciliar no es un movimiento)
--    con dos diferencias a propósito:
--      · NO anota los ids en kommo_backfill_seen: esa tabla es el insumo de UN
--        recorrido completo del backfill para saber qué leads borraron en Kommo;
--        una ventana de 35 días de tres pipelines no es un recorrido completo y
--        le haría creer que vio leads que el recorrido no vio.
--      · solo lleva etapa/pipeline y limpia la marca «no existe en Kommo» (si
--        Kommo devuelve el lead, existe).
--
-- 2) trigger_kommo_funnel_sync(): kommo-funnel-sync tiene verify_jwt = false y
--    estaba SIN gate: cualquiera con la URL podía dispararla (lecturas masivas a
--    Kommo + upserts). Ahora exige x-internal-secret (_shared/auth.ts) y el cron
--    lo manda desde _app_secrets (0061), igual que trigger_sync_pipelines().
--    ORDEN DE DESPLIEGUE: aplicar esta migración ANTES de desplegar la función
--    (la versión vieja de la función ignora el header; la nueva lo exige).
--
-- IDEMPOTENTE.
-- =============================================================

create or replace function reconcile_funnel_lead_positions(p_leads jsonb, p_read_at timestamptz default now())
returns int language sql set search_path = public, pg_temp as $$
  select apply_positions_batch(p_leads, p_read_at, false);
$$;

revoke execute on function reconcile_funnel_lead_positions(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function reconcile_funnel_lead_positions(jsonb, timestamptz) to service_role;

create or replace function trigger_kommo_funnel_sync()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_secret text;
begin
  select valor into v_secret from _app_secrets where clave = 'INTERNAL_FUNCTION_SECRET';
  if v_secret is null then
    raise warning 'trigger_kommo_funnel_sync: falta INTERNAL_FUNCTION_SECRET en _app_secrets';
    return;
  end if;
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/kommo-funnel-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

revoke execute on function trigger_kommo_funnel_sync() from public, anon, authenticated;

comment on table salesbot_funnel_leads is
  'Snapshot del funnel de los Salesbots de Kommo (Cumpleaños / Alquiler de Salas, 3 sedes). Lo llena kommo-funnel-sync leyendo custom fields en vivo: los webhooks leads.update/status solo sincronizan etapa y pipeline (process-inbound), no el avance del bot, y el campo es acumulativo así que el snapshot alcanza sin historial de eventos.';
