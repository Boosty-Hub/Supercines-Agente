-- =============================================================
-- 0009_outcomes_cron.sql
-- Schedule sweep para evaluate-outcomes cada 5 min (re-calcula lead_replied
-- de drafts en ventana 72h, y agarra cualquier outcome faltante).
-- =============================================================

create or replace function trigger_evaluate_outcomes()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/evaluate-outcomes',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'evaluate-outcomes-sweep') then
    perform cron.schedule(
      'evaluate-outcomes-sweep',
      '*/5 * * * *',
      $cron$select trigger_evaluate_outcomes();$cron$
    );
  end if;
end$$;
