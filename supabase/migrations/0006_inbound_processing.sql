-- =============================================================
-- 0006_inbound_processing.sql
-- Habilita pg_cron y pg_net; agrega claim atómico y schedule
-- que invoca la Edge Function process-inbound cada minuto.
-- =============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Claim atómico: toma N pending, los marca processing, los devuelve.
-- Usa SKIP LOCKED para que múltiples workers no choquen.
create or replace function claim_inbound_batch(p_limit int default 20)
returns table (id uuid, payload jsonb) language plpgsql as $$
begin
  return query
  with claimed as (
    select inbound_queue.id
    from inbound_queue
    where inbound_queue.status = 'pending'
    order by inbound_queue.created_at
    limit p_limit
    for update skip locked
  )
  update inbound_queue q
     set status = 'processing',
         attempts = q.attempts + 1
    from claimed c
   where q.id = c.id
   returning q.id, q.payload;
end;
$$;

-- Función que invoca process-inbound vía pg_net (HTTP async).
-- La Edge Function está deployada con --no-verify-jwt: no requiere auth header.
create or replace function trigger_process_inbound()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/process-inbound',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- Schedule: sweep cada 1 minuto.
-- El webhook ya dispara directamente; este cron es resilience para
-- payloads que el webhook no logró encolar o que fallaron.
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'process-inbound-sweep') then
    perform cron.schedule(
      'process-inbound-sweep',
      '* * * * *',
      $cron$select trigger_process_inbound();$cron$
    );
  end if;
end$$;
