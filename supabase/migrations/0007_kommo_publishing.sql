-- =============================================================
-- 0007_kommo_publishing.sql
-- Configuración de publicación a Kommo (campo + salesbot) y schedule sweep.
-- =============================================================

create table if not exists kommo_publish_config (
  id uuid primary key default gen_random_uuid(),
  -- Campo custom donde se escribe el body de la respuesta (Kommo lo lee desde un salesbot)
  response_custom_field_id bigint,
  -- ID del salesbot que envía el mensaje al canal
  salesbot_id bigint,
  -- Master switch: si false, generamos drafts pero NO publicamos
  publishing_enabled boolean not null default false,
  -- Cómo manejamos verticales con auto_reply=true
  --   'auto'        → publica al instante
  --   'review_only' → siempre va a review humana
  auto_reply_mode text not null default 'auto'
    check (auto_reply_mode in ('auto','review_only')),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists kommo_publish_config_updated_at on kommo_publish_config;
create trigger kommo_publish_config_updated_at before update on kommo_publish_config
  for each row execute function set_updated_at();

create unique index if not exists kommo_publish_config_one_active
  on kommo_publish_config(is_active)
  where is_active = true;

alter table kommo_publish_config enable row level security;
drop policy if exists authenticated_all on kommo_publish_config;
create policy authenticated_all on kommo_publish_config
  for all to authenticated using (true) with check (true);

-- Seed singleton si no existe
insert into kommo_publish_config (publishing_enabled, auto_reply_mode, is_active)
select false, 'auto', true
where not exists (select 1 from kommo_publish_config where is_active = true);

-- Función trigger que invoca publish-to-kommo vía pg_net
create or replace function trigger_publish_to_kommo()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/publish-to-kommo',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- Schedule: sweep cada 1 minuto
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'publish-to-kommo-sweep') then
    perform cron.schedule(
      'publish-to-kommo-sweep',
      '* * * * *',
      $cron$select trigger_publish_to_kommo();$cron$
    );
  end if;
end$$;
