-- =============================================================
-- 0019_agent_tools.sql
-- Registry of tools exposed to the Managed Agent.
--
-- tool_type='system' → always-on built-in (search_kb + agent_toolset).
--   These rows are display-only in the dashboard and CANNOT be
--   deleted, disabled, or renamed via the API.
-- tool_type='http'   → operator-defined HTTP tools, fully editable.
--   Changes take effect in the Edge Function within 60s (toolsCache TTL).
--
-- IDEMPOTENT: safe to re-run — uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- Reuses set_updated_at() defined in 0001_init.sql — do NOT redefine it here.
-- =============================================================

create table if not exists agent_tools (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,              -- snake_case, [a-z0-9_]; matches Anthropic tool name
  description   text not null,                     -- shown to agent (routing) AND in dashboard
  tool_type     text not null default 'http'
                  check (tool_type in ('system', 'http')),
  enabled       boolean not null default true,
  http_method   text check (http_method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  url_template  text check (url_template is null or url_template like 'https://%'),  -- https-only; {{param}} placeholders
  headers       jsonb not null default '[]'::jsonb,  -- array of {name, value}; value may contain {{CONFIG_KEY}}
  body_template jsonb,                             -- nullable; JSON template with {{param}} (non-GET only)
  input_schema  jsonb not null default '{"type":"object","properties":{},"required":[]}'::jsonb,
  timeout_ms    integer not null default 8000,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table agent_tools enable row level security;

-- Mirror verticals RLS: authenticated user has full access.
-- service_role (Edge Functions) bypasses RLS inherently.
drop policy if exists agent_tools_authenticated on agent_tools;
create policy agent_tools_authenticated on agent_tools
  for all
  to authenticated
  using (true)
  with check (true);

-- Reuse the existing set_updated_at() function from 0001_init.sql.
drop trigger if exists agent_tools_updated_at on agent_tools;
create trigger agent_tools_updated_at before update on agent_tools
  for each row execute function set_updated_at();

-- Partial index for the Edge Function's enabled-http-tools query.
create index if not exists agent_tools_enabled_idx
  on agent_tools (enabled)
  where tool_type = 'http';

-- =============================================================
-- Seed the two system rows (single source of truth — DB, not code).
-- buildAgentTools() in the web layer reads these rows from the DB; it does
-- NOT hardcode their definitions. They stay always-on because they seed with
-- enabled=true and the API rejects deleting/disabling/renaming any system row
-- (403). search_kb keeps its special handler in generate-response (embed+RPC);
-- agent_toolset_20260401 is rendered as Anthropic's native toolset type.
-- =============================================================
insert into agent_tools (name, description, tool_type, enabled, http_method, url_template, input_schema)
values
  (
    'search_kb',
    'Búsqueda semántica + full-text sobre la Knowledge Base del operador (precios documentados, condiciones, FAQs). Devuelve los chunks más relevantes con su título de documento. Úsalo SOLO para responder preguntas factuales. Built-in del sistema.',
    'system', true, null, null,
    '{"type":"object","properties":{"query":{"type":"string","description":"Consulta corta y específica."},"limit":{"type":"integer","description":"Número de chunks a devolver. Default 5, máx 12."}},"required":["query"]}'::jsonb
  ),
  (
    'agent_toolset_20260401',
    'Toolset gestionado de Anthropic (filesystem sobre Memory Stores: grep/glob/read/write/ls). Built-in del sistema.',
    'system', true, null, null,
    '{"type":"object","properties":{}}'::jsonb
  )
on conflict (name) do nothing;
