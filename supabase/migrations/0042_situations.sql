-- =============================================================
-- 0042_situations.sql
-- "Situaciones": contexto situacional vigente (un feriado, un terremoto, una
-- promo de temporada excepcional…) que el agente SIEMPRE debe tener en cuenta al
-- responder. Se inyecta al contexto en vivo, igual que promotions (0033), pero
-- con marco "siempre relevante" en vez de "solo si viene al caso".
-- IDEMPOTENT. Reutiliza set_updated_at() de 0001. RLS mirrors promotions.
-- =============================================================
create table if not exists situations (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  content     text not null,                       -- texto que el agente inyecta al contexto
  starts_at   date,                                -- nullable; vigente desde
  ends_at     date,                                -- nullable; INCLUSIVE
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists situations_updated_at on situations;
create trigger situations_updated_at before update on situations
  for each row execute function set_updated_at();

alter table situations enable row level security;
drop policy if exists authenticated_all on situations;
create policy authenticated_all on situations
  for all to authenticated using (true) with check (true);

create index if not exists situations_enabled_idx on situations(enabled) where enabled = true;
