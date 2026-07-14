-- =============================================================
-- 0010_dreams_cron.sql
-- Schedule Dreams: daily 3 AM UTC, weekly domingo 3 AM UTC.
-- =============================================================

create or replace function trigger_dreams(p_period text)
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/dreams-run',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('period', p_period),
    timeout_milliseconds := 120000
  );
end;
$$;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'dreams-daily') then
    perform cron.schedule(
      'dreams-daily',
      '0 3 * * *',
      $cron$select trigger_dreams('daily');$cron$
    );
  end if;
  if not exists (select 1 from cron.job where jobname = 'dreams-weekly') then
    perform cron.schedule(
      'dreams-weekly',
      '0 3 * * 0',
      $cron$select trigger_dreams('weekly');$cron$
    );
  end if;
end$$;
