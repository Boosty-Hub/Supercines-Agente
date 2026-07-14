-- =============================================================
-- 0036_lead_stage_events.sql
-- Registra cada cambio de etapa de un lead: quién lo movió (agente o Kommo),
-- de cuál etapa, a cuál, y cuándo. Permite mostrar la línea de tiempo visual
-- de pipeline en el inbox.
-- IDEMPOTENT. RLS mirrors verticals (authenticated all, service_role bypass).
-- =============================================================

create table if not exists lead_stage_events (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references leads(id) on delete cascade,
  from_stage_id    bigint null,
  to_stage_id      bigint not null,
  from_stage_name  text null,
  to_stage_name    text null,
  pipeline_name    text null,
  moved_by         text not null check (moved_by in ('agente', 'kommo')),
  draft_id         uuid null references drafts(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists lead_stage_events_lead_created_idx
  on lead_stage_events(lead_id, created_at);

alter table lead_stage_events enable row level security;
drop policy if exists authenticated_all on lead_stage_events;
create policy authenticated_all on lead_stage_events
  for all to authenticated using (true) with check (true);

-- Registrar esta migración en la tabla de control
insert into _migrations (filename)
values ('0036_lead_stage_events.sql')
on conflict (filename) do nothing;
