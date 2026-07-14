-- =============================================================
-- 0008_realtime.sql
-- Habilita Realtime sobre messages, drafts y leads para que el
-- dashboard reciba cambios en vivo via Postgres Changes.
-- =============================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table messages, drafts, leads;
  end if;
exception
  when duplicate_object then null;
end$$;
