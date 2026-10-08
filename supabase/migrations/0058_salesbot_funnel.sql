-- =============================================================
-- 0058_salesbot_funnel.sql
-- Funnel de los 3 Salesbots nativos de Kommo (uno por sede: Caracas/"Altos
-- Mirandinos", Valencia, Maracay) que atienden Cumpleaños y Alquiler de
-- Salas. El bot vive 100% dentro de Kommo (Muvito no interviene) y nunca
-- mueve al lead de etapa — va llenando custom fields del lead a medida que
-- avanza. Kommo descarta los webhooks `leads.update` (ver
-- kommo-webhook/index.ts → isActionable), así que no hay historial interno
-- de este recorrido: esta tabla es un SNAPSHOT que llena periódicamente la
-- Edge Function `kommo-funnel-sync` leyendo directo de la API de Kommo. Los
-- campos son acumulativos (nunca se revierten), así que el snapshot alcanza
-- para reconstruir el funnel sin necesitar replay de eventos históricos.
--
-- furthest_step_index: posición más avanzada alcanzada dentro de la lista de
-- pasos de su flow_type (ver kommo-funnel-sync/index.ts para el orden
-- exacto). Tolerante a huecos — se toma el MÁXIMO campo no vacío, no se exige
-- contigüidad (verificado contra datos reales: un lead de alquiler puede
-- tener "Horario" lleno sin tener "Fecha").
--
-- IDEMPOTENTE.
-- =============================================================

create table if not exists salesbot_funnel_leads (
  id                  uuid primary key default gen_random_uuid(),
  kommo_lead_id       bigint not null unique,
  kommo_contact_id    bigint,
  sede                text not null check (sede in ('caracas','valencia','maracay')),
  flow_type           text not null check (flow_type in ('cumpleanos','alquiler_salas')),
  status_id           bigint,
  responsible_user_id bigint,
  contact_name        text,
  contact_email       text,
  step_sede           text,
  step_paquete        text,
  step_ninos          text,
  step_adultos        text,
  step_motivo         text,
  step_asistentes     text,
  step_horario        text,
  step_elementos      text,
  step_fecha          text,
  furthest_step_index smallint not null default 0,
  reached_human        boolean not null default false,
  kommo_created_at    timestamptz not null,
  kommo_updated_at    timestamptz,
  last_synced_at      timestamptz not null default now()
);

create index if not exists salesbot_funnel_leads_sede_flow_idx
  on salesbot_funnel_leads(sede, flow_type, kommo_created_at);

alter table salesbot_funnel_leads enable row level security;
drop policy if exists authenticated_all on salesbot_funnel_leads;
create policy authenticated_all on salesbot_funnel_leads
  for all to authenticated using (true) with check (true);

comment on table salesbot_funnel_leads is
  'Snapshot del funnel de los Salesbots de Kommo (Cumpleaños / Alquiler de Salas, 3 sedes). Lo llena kommo-funnel-sync leyendo custom fields en vivo — no hay historial de eventos, el campo es acumulativo así que el snapshot alcanza.';
comment on column salesbot_funnel_leads.furthest_step_index is
  'Posición más avanzada alcanzada en el guion de su flow_type (orden definido en kommo-funnel-sync/index.ts). Tolerante a huecos intermedios.';
comment on column salesbot_funnel_leads.reached_human is
  'true cuando el último campo esperado del flujo está lleno = el bot terminó su guion y la asesora humana toma la conversación.';

-- ---- Cron: sync cada 15 minutos ------------------------------------------
create or replace function trigger_kommo_funnel_sync()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/kommo-funnel-sync',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'kommo-funnel-sync-sweep') then
    perform cron.schedule(
      'kommo-funnel-sync-sweep',
      '*/15 * * * *',
      $cron$select trigger_kommo_funnel_sync();$cron$
    );
  end if;
end$$;
