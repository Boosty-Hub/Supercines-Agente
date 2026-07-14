-- =============================================================
-- 0020_follow_up_tables.sql
-- Tablas del agente de seguimiento automático de WhatsApp.
-- IDEMPOTENT: if not exists / on conflict do nothing.
-- Reutiliza set_updated_at() de 0001 — NO redefine.
-- RLS: mirrors verticals (authenticated all + service_role bypasses).
-- =============================================================

-- =============================================================
-- follow_up_fields: mapea una variable semántica a un campo Kommo
-- =============================================================
create table if not exists follow_up_fields (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,                        -- etiqueta humana en el dashboard
  kommo_field_id bigint not null unique,               -- campo custom_field de Kommo que parchear
  created_at     timestamptz not null default now()
);

alter table follow_up_fields enable row level security;
drop policy if exists authenticated_all on follow_up_fields;
create policy authenticated_all on follow_up_fields
  for all to authenticated using (true) with check (true);

-- =============================================================
-- follow_up_templates: una plantilla de WhatsApp aprobada = un salesbot
-- =============================================================
create table if not exists follow_up_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,                                    -- cuándo usar, para el operador + agente
  body        text not null,                           -- cuerpo fijo de la plantilla (ya aprobado por Meta)
  variables   jsonb not null default '[]'::jsonb,      -- [{name, description, field_id}] field_id → follow_up_fields.id
  salesbot_id bigint,                                  -- salesbot de Kommo que envía ESTA plantilla
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists follow_up_templates_updated_at on follow_up_templates;
create trigger follow_up_templates_updated_at before update on follow_up_templates
  for each row execute function set_updated_at();

alter table follow_up_templates enable row level security;
drop policy if exists authenticated_all on follow_up_templates;
create policy authenticated_all on follow_up_templates
  for all to authenticated using (true) with check (true);

-- =============================================================
-- follow_up_steps: secuencia ordenada; cada paso asigna UNA plantilla + demora
-- =============================================================
create table if not exists follow_up_steps (
  id          uuid primary key default gen_random_uuid(),
  step_number int not null unique,                     -- 1, 2, 3...
  delay_hours int not null,                            -- horas de silencio antes de que este paso dispare
  template_id uuid references follow_up_templates(id) on delete set null,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists follow_up_steps_updated_at on follow_up_steps;
create trigger follow_up_steps_updated_at before update on follow_up_steps
  for each row execute function set_updated_at();

alter table follow_up_steps enable row level security;
drop policy if exists authenticated_all on follow_up_steps;
create policy authenticated_all on follow_up_steps
  for all to authenticated using (true) with check (true);

-- =============================================================
-- follow_up_config: singleton, mirrors kommo_publish_config
-- =============================================================
create table if not exists follow_up_config (
  id                   uuid primary key default gen_random_uuid(),
  is_active            boolean not null default true,
  enabled              boolean not null default false,     -- SHIPS DISABLED (seguridad)
  timezone             text not null default 'America/Guayaquil',
  business_hours_start int not null default 9,             -- [start, end) — hora de inicio
  business_hours_end   int not null default 20,            -- hora de fin (excluida)
  active_days          int[] not null default '{1,2,3,4,5,6}'::int[],  -- ISODOW 1=Lun..7=Dom
  max_follow_ups       int not null default 3,
  min_gap_hours        int not null default 20,            -- mínimo entre envíos al mismo lead
  stop_stage_ids       bigint[] not null default '{}'::bigint[], -- etapas de Kommo que detienen la secuencia
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
drop trigger if exists follow_up_config_updated_at on follow_up_config;
create trigger follow_up_config_updated_at before update on follow_up_config
  for each row execute function set_updated_at();

create unique index if not exists follow_up_config_one_active
  on follow_up_config(is_active)
  where is_active = true;

alter table follow_up_config enable row level security;
drop policy if exists authenticated_all on follow_up_config;
create policy authenticated_all on follow_up_config
  for all to authenticated using (true) with check (true);

-- =============================================================
-- follow_ups: log de envíos (append-only)
-- =============================================================
create table if not exists follow_ups (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references leads(id) on delete cascade,
  template_id uuid references follow_up_templates(id) on delete set null,
  step        int not null,
  status      text not null,                           -- 'sent' | 'failed'
  variables   jsonb not null default '{}'::jsonb,      -- variables resueltas {name: value}
  error       text,
  sent_at     timestamptz not null default now()
);
create index if not exists follow_ups_lead_idx on follow_ups(lead_id, sent_at desc);

alter table follow_ups enable row level security;
drop policy if exists authenticated_all on follow_ups;
create policy authenticated_all on follow_ups
  for all to authenticated using (true) with check (true);

-- NOTA: la función follow_up_due_leads se crea en 0021_leads_follow_up.sql,
-- DESPUÉS de agregar las columnas de seguimiento a `leads` (de las que depende).
-- Mantener ese orden: 0020 (tablas+seeds) → 0021 (columnas leads + función).

-- =============================================================
-- Seeds idempotentes
-- =============================================================
-- NO seedeamos plantillas ni pasos: el operador las crea con IA desde
-- /seguimiento (más fácil y mejor que ejemplos genéricos). La IA arma la
-- plantilla Y el paso de la secuencia en pocos clicks.

-- Singleton de config (enabled=FALSE — no envía nada hasta que el operador lo active)
insert into follow_up_config (enabled, is_active)
select false, true
where not exists (select 1 from follow_up_config where is_active = true);
