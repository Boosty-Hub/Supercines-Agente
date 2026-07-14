-- =============================================================
-- 0004_memory_items.sql
-- Tabla stub para Memory Stores de Anthropic (espejo local con FTS).
-- store_name usa labels semánticos 'master' (global) / 'leads' (per-lead).
-- Los IDs reales de los Memory Stores en Anthropic viven en env vars
-- (ANTHROPIC_MEMORY_MASTER_ID / ANTHROPIC_MEMORY_LEADS_ID).
-- =============================================================

create table if not exists memory_items (
  id uuid primary key default gen_random_uuid(),
  store_name text not null check (store_name in ('master','leads')),
  -- Path: para 'leads' es siempre /{lead_id}/, para 'master' es null
  lead_id uuid references leads(id) on delete cascade,
  -- Origen lógico: voice_sample, conversation, dream_distillation, etc
  source_kind text not null,
  source_id uuid,
  content text not null,
  -- Para búsqueda full-text en español
  content_tsv tsvector generated always as (to_tsvector('spanish', content)) stored,
  metadata jsonb not null default '{}'::jsonb,
  -- Cuando se sincroniza al Anthropic Memory Store real, este campo lo guarda
  anthropic_memory_id text,
  created_at timestamptz not null default now()
);

create index if not exists memory_items_store_lead_idx
  on memory_items(store_name, lead_id);
create index if not exists memory_items_source_idx
  on memory_items(source_kind, source_id);
create index if not exists memory_items_fts_idx
  on memory_items using gin (content_tsv);
create index if not exists memory_items_trgm_idx
  on memory_items using gin (content gin_trgm_ops);

alter table memory_items enable row level security;
drop policy if exists authenticated_all on memory_items;
create policy authenticated_all on memory_items
  for all to authenticated using (true) with check (true);

-- Función helper para búsqueda hybrid (FTS + trigram similarity)
create or replace function search_memory(
  p_store_name text,
  p_lead_id uuid,
  p_query text,
  p_limit int default 8
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  rank real
) language sql stable as $$
  select
    id,
    content,
    metadata,
    (
      ts_rank(content_tsv, plainto_tsquery('spanish', p_query)) * 0.6 +
      similarity(content, p_query) * 0.4
    )::real as rank
  from memory_items
  where store_name = p_store_name
    and (
      (p_lead_id is null and lead_id is null)
      or (p_lead_id is not null and lead_id = p_lead_id)
      or store_name = 'master'
    )
    and (
      content_tsv @@ plainto_tsquery('spanish', p_query)
      or content % p_query
    )
  order by rank desc
  limit p_limit;
$$;
