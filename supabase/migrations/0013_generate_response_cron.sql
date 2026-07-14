-- =============================================================
-- 0013_generate_response_cron.sql
-- Sweep de resiliencia para generate-response. El webhook dispara
-- la cadena process-inbound -> generate-response, pero si ese
-- fire-and-forget se corta, este cron recoge mensajes clasificados
-- sin draft y los procesa. generate-response responde 202 al toque
-- y corre el agente bajo EdgeRuntime.waitUntil, así que cada llamada
-- procesa un mensaje sin que pg_net espere los 60-80s del agente.
-- =============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Invoca generate-response (sin body = modo cola: toma el más viejo
-- clasificado sin draft, reclamando drafts 'generating' stale >3min).
-- Deployada con verify_jwt=false: no requiere auth header.
create or replace function trigger_generate_response()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/generate-response',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$$;

-- Schedule: sweep cada 1 minuto.
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'generate-response-sweep') then
    perform cron.schedule(
      'generate-response-sweep',
      '* * * * *',
      $cron$select trigger_generate_response();$cron$
    );
  end if;
end$$;
