-- =============================================================
-- 0022_follow_up_cron.sql
-- Cron de barrido de seguimiento: llama a follow-up-scan cada 5 minutos.
-- IDEMPOTENT: guarda contra creación doble del job.
-- NOTA: ${SUPABASE_URL} es un placeholder sustituido en runtime por
--       web/src/app/api/provision/migrate/route.ts — NO hardcodear la URL.
-- =============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Función trigger que invoca follow-up-scan vía pg_net
create or replace function trigger_follow_up_scan()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url                  := '${SUPABASE_URL}/functions/v1/follow-up-scan',
    headers              := '{"Content-Type":"application/json"}'::jsonb,
    body                 := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- Schedule: cada 5 minutos (alineado con la ventana del edge function)
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'follow-up-scan-sweep') then
    perform cron.schedule(
      'follow-up-scan-sweep',
      '*/5 * * * *',
      $cron$select trigger_follow_up_scan();$cron$
    );
  end if;
end$$;
