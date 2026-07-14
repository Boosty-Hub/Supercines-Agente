-- =============================================================
-- 0033_promotions.sql
-- Promos/eventos que el agente conoce en vivo (context injection).
-- IDEMPOTENT. Reutiliza set_updated_at() de 0001. RLS mirrors verticals.
-- =============================================================
create table if not exists promotions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  content     text not null,                       -- texto que el agente inyecta al contexto
  kind        text not null default 'promo' check (kind in ('promo','evento')),
  starts_at   date,                                -- nullable; rango si existe
  ends_at     date,                                -- nullable; INCLUSIVE
  weekdays    int[],                               -- nullable; ISODOW 1=Lun..7=Dom
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists promotions_updated_at on promotions;
create trigger promotions_updated_at before update on promotions
  for each row execute function set_updated_at();

alter table promotions enable row level security;
drop policy if exists authenticated_all on promotions;
create policy authenticated_all on promotions
  for all to authenticated using (true) with check (true);

create index if not exists promotions_enabled_idx on promotions(enabled) where enabled = true;
