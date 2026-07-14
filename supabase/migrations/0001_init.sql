-- =============================================================
-- 0001_init.sql — extensiones, función updated_at, tablas core
-- =============================================================

-- Extensiones
create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;

-- Trigger function: updated_at automático
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- =============================================================
-- verticals — categorías de mensajes, editables desde frontend
-- =============================================================
create table if not exists verticals (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  system_prompt text not null,
  auto_reply boolean not null default false,
  requires_review boolean not null default false,
  examples jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists verticals_updated_at on verticals;
create trigger verticals_updated_at before update on verticals
  for each row execute function set_updated_at();

-- =============================================================
-- graders — criterios de evaluación de Outcomes, editables
-- =============================================================
create table if not exists graders (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  prompt text not null,
  scale text not null default 'numeric_0_1'
    check (scale in ('numeric_0_1','pass_fail')),
  weight numeric(4,2) not null default 1.0,
  enabled boolean not null default true,
  source text not null default 'llm_judge'
    check (source in ('llm_judge','automatic','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists graders_updated_at on graders;
create trigger graders_updated_at before update on graders
  for each row execute function set_updated_at();

-- =============================================================
-- leads — un lead por contact_id de Kommo
-- =============================================================
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  kommo_lead_id bigint unique,
  kommo_contact_id bigint,
  channel text,
  display_name text,
  first_seen_at timestamptz not null default now(),
  last_message_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists leads_updated_at on leads;
create trigger leads_updated_at before update on leads
  for each row execute function set_updated_at();
create index if not exists leads_kommo_lead_id_idx on leads(kommo_lead_id);
create index if not exists leads_last_message_at_idx
  on leads(last_message_at desc nulls last);

-- =============================================================
-- messages — todo mensaje (inbound + outbound)
-- =============================================================
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  source text,
  content text not null,
  kommo_message_id text,
  vertical_id uuid references verticals(id),
  classification jsonb,
  requires_human_review boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_lead_id_idx
  on messages(lead_id, created_at desc);
create index if not exists messages_requires_review_idx
  on messages(requires_human_review)
  where requires_human_review = true;
create index if not exists messages_vertical_idx on messages(vertical_id);

-- =============================================================
-- drafts — respuesta del agente (puede ser auto-enviada o manual)
-- =============================================================
create table if not exists drafts (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  body text not null,
  edited_body text,
  status text not null default 'pending'
    check (status in ('pending','approved','sent','rejected','auto_sent','failed')),
  agent_metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  reviewer_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists drafts_updated_at on drafts;
create trigger drafts_updated_at before update on drafts
  for each row execute function set_updated_at();
create index if not exists drafts_status_idx on drafts(status, created_at desc);
create index if not exists drafts_message_idx on drafts(message_id);

-- =============================================================
-- outcomes — score por draft × grader
-- =============================================================
create table if not exists outcomes (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references drafts(id) on delete cascade,
  grader_id uuid not null references graders(id) on delete cascade,
  score numeric(4,3),
  passed boolean,
  reasoning text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(draft_id, grader_id)
);
create index if not exists outcomes_grader_idx
  on outcomes(grader_id, created_at desc);

-- =============================================================
-- inbound_queue — cola desacoplada del webhook
-- =============================================================
create table if not exists inbound_queue (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'kommo_webhook',
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','processing','done','failed')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists inbound_queue_pending_idx
  on inbound_queue(created_at)
  where status in ('pending','processing');

-- =============================================================
-- kommo_credentials — un solo registro activo (singleton)
-- =============================================================
create table if not exists kommo_credentials (
  id uuid primary key default gen_random_uuid(),
  subdomain text not null,
  client_id text not null,
  encrypted_access_token text not null,
  encrypted_refresh_token text not null,
  token_expires_at timestamptz not null,
  scope text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists kommo_credentials_updated_at on kommo_credentials;
create trigger kommo_credentials_updated_at before update on kommo_credentials
  for each row execute function set_updated_at();
create unique index if not exists kommo_credentials_one_active
  on kommo_credentials(is_active)
  where is_active = true;

-- =============================================================
-- kb_documents + kb_chunks — base de conocimiento (RAG)
-- =============================================================
create table if not exists kb_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_type text not null,
  source_filename text,
  raw_text text,
  metadata jsonb not null default '{}'::jsonb,
  total_chunks int not null default 0,
  embeddings_provider text,
  embeddings_dim int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists kb_documents_updated_at on kb_documents;
create trigger kb_documents_updated_at before update on kb_documents
  for each row execute function set_updated_at();

create table if not exists kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references kb_documents(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536),
  token_count int,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists kb_chunks_document_idx
  on kb_chunks(document_id, chunk_index);
create index if not exists kb_chunks_embedding_idx
  on kb_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists kb_chunks_content_fts_idx
  on kb_chunks using gin (to_tsvector('spanish', content));

-- =============================================================
-- voice_samples — ingestas de voz del operador (chats, transcripciones, reglas)
-- =============================================================
create table if not exists voice_samples (
  id uuid primary key default gen_random_uuid(),
  type text not null
    check (type in ('chat_export','transcript','rule','example_response')),
  title text not null,
  content text not null,
  source_filename text,
  metadata jsonb not null default '{}'::jsonb,
  anthropic_memory_id text,
  ingested_at timestamptz,
  created_at timestamptz not null default now()
);

-- =============================================================
-- RLS — habilitar en todas las tablas
-- (service_role bypasses; authenticated tiene acceso completo
-- porque solo el usuario master se loguea al dashboard)
-- =============================================================
alter table verticals          enable row level security;
alter table graders            enable row level security;
alter table leads              enable row level security;
alter table messages           enable row level security;
alter table drafts             enable row level security;
alter table outcomes           enable row level security;
alter table inbound_queue      enable row level security;
alter table kommo_credentials  enable row level security;
alter table kb_documents       enable row level security;
alter table kb_chunks          enable row level security;
alter table voice_samples      enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array[
    'verticals','graders','leads','messages','drafts','outcomes',
    'inbound_queue','kb_documents','kb_chunks','voice_samples'
  ]) loop
    execute format(
      'drop policy if exists authenticated_all on %I;
       create policy authenticated_all on %I
         for all to authenticated using (true) with check (true);',
      t, t
    );
  end loop;
end$$;

-- kommo_credentials: leer ok, escribir solo service_role
drop policy if exists authenticated_read on kommo_credentials;
create policy authenticated_read on kommo_credentials
  for select to authenticated using (true);
