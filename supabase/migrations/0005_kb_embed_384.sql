-- =============================================================
-- 0005_kb_embed_384.sql
-- Cambia la dimensión de embeddings a 384 (Supabase.ai gte-small).
-- =============================================================

-- Dropear el índice ivfflat (depende del tipo)
drop index if exists kb_chunks_embedding_idx;

-- Cambiar dimensión
alter table kb_chunks
  alter column embedding type vector(384) using null;

-- Recrear índice
create index kb_chunks_embedding_idx
  on kb_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Función RPC: búsqueda híbrida (vector + FTS) sobre kb_chunks
create or replace function search_kb(
  p_query_embedding vector(384),
  p_query_text text,
  p_limit int default 6,
  p_min_similarity real default 0.0
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  content text,
  metadata jsonb,
  similarity real,
  fts_rank real
) language sql stable as $$
  with vec as (
    select
      c.id as chunk_id,
      c.document_id,
      d.title as document_title,
      c.content,
      c.metadata,
      (1 - (c.embedding <=> p_query_embedding))::real as similarity,
      ts_rank(to_tsvector('spanish', c.content), plainto_tsquery('spanish', p_query_text))::real as fts_rank
    from kb_chunks c
    join kb_documents d on d.id = c.document_id
    where c.embedding is not null
  )
  select * from vec
  where similarity >= p_min_similarity
  order by (similarity * 0.7 + fts_rank * 0.3) desc
  limit p_limit;
$$;

-- Update default embeddings_provider para nuevos docs
comment on column kb_documents.embeddings_provider is 'supabase_ai_gte_small (384 dims) — actual';
