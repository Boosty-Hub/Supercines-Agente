-- =============================================================
-- 0011_alerts.sql
-- Sistema de alertas: drafts fallidos, mensajes que requieren review,
-- regresiones de outcomes. Webhook configurable para Slack/Discord/etc.
-- =============================================================

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                  -- 'draft_failed' | 'human_review_needed' | 'outcomes_regression' | etc.
  severity text not null default 'warning'
    check (severity in ('info','warning','critical')),
  title text not null,
  description text,
  ref_table text,                       -- 'drafts' | 'messages' | etc
  ref_id uuid,                          -- id de la entidad
  metadata jsonb not null default '{}'::jsonb,
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists alerts_unacked_idx
  on alerts(created_at desc)
  where acknowledged_at is null;
create index if not exists alerts_ref_idx on alerts(ref_table, ref_id);

alter table alerts enable row level security;
drop policy if exists authenticated_all on alerts;
create policy authenticated_all on alerts
  for all to authenticated using (true) with check (true);

-- ---- Config singleton ----
create table if not exists alert_config (
  id uuid primary key default gen_random_uuid(),
  webhook_url text,
  webhook_enabled boolean not null default false,
  -- Qué kinds disparan el webhook (default: todas)
  webhook_kinds text[] not null default array['draft_failed','human_review_needed','outcomes_regression']::text[],
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists alert_config_updated_at on alert_config;
create trigger alert_config_updated_at before update on alert_config
  for each row execute function set_updated_at();

create unique index if not exists alert_config_one_active
  on alert_config(is_active) where is_active = true;

alter table alert_config enable row level security;
drop policy if exists authenticated_all on alert_config;
create policy authenticated_all on alert_config
  for all to authenticated using (true) with check (true);

insert into alert_config (webhook_enabled, is_active)
select false, true
where not exists (select 1 from alert_config where is_active = true);

-- ---- Cron sweep ----
create or replace function trigger_alerts_scan()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/alerts-scan',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'alerts-scan-sweep') then
    perform cron.schedule(
      'alerts-scan-sweep',
      '*/5 * * * *',
      $cron$select trigger_alerts_scan();$cron$
    );
  end if;
end$$;

-- Habilitar realtime sobre alerts
do $$
begin
  alter publication supabase_realtime add table alerts;
exception
  when duplicate_object then null;
end$$;
