-- =============================================================
-- 0017_runtime_config.sql
-- Runtime configuration table: single source of truth for all
-- per-client credentials and identity settings.
--
-- SECURITY TRADEOFF: credentials are stored as plaintext, protected
-- only by RLS (authenticated + service_role access). pgcrypto
-- encryption is deferred to a future iteration.
--
-- PRECEDENCE RULE: the web app and Edge Functions resolve every key
-- using DB-first / env-fallback:
--   1. runtime_config.value WHERE key=K, if row exists AND value IS
--      NOT NULL AND value != '' → use it.
--   2. Otherwise the environment variable (Deno.env.get or process.env).
--   3. Otherwise undefined → caller decides (throw or use default).
--
-- A NULL or empty DB value is treated as ABSENT (never as an intentional
-- empty override). This guarantees pre-wizard parity: an empty table
-- behaves exactly like the env-only setup.
-- =============================================================

create table if not exists runtime_config (
  key        text primary key,
  value      text,                             -- nullable; absent/null → reader falls back to env
  is_secret  boolean not null default false,   -- hint for future masking in UI/logs
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table runtime_config enable row level security;

-- Master (single authenticated user) has full access.
-- service_role bypasses RLS inherently — Edge Functions and scripts use it.
drop policy if exists runtime_config_authenticated on runtime_config;
create policy runtime_config_authenticated
  on runtime_config
  for all
  to authenticated
  using (true)
  with check (true);

-- Seed identity + credential keys with NULL values so the table is
-- never empty after migration. All values start as NULL → env wins
-- (pre-wizard parity). The wizard writes the real values later.
-- Uses ON CONFLICT DO NOTHING so re-running the migration is safe.
insert into runtime_config (key, value, is_secret) values
  ('OPERATOR_NAME',              null, false),
  ('AGENT_NAME',                 null, false),
  ('MEMORY_STORE_MASTER_NAME',   null, false),
  ('MEMORY_STORE_LEADS_NAME',    null, false),
  ('NEXT_PUBLIC_AGENT_LABEL',    null, false),
  ('ANTHROPIC_API_KEY',          null, true),
  ('ANTHROPIC_AGENT_ID',         null, true),
  ('ANTHROPIC_AGENT_VERSION',    null, true),
  ('ANTHROPIC_ENVIRONMENT_ID',   null, true),
  ('ANTHROPIC_MEMORY_MASTER_ID', null, true),
  ('ANTHROPIC_MEMORY_LEADS_ID',  null, true),
  ('KOMMO_API_DOMAIN',           null, false),
  ('KOMMO_ACCESS_TOKEN',         null, true),
  ('KOMMO_SUBDOMAIN',            null, false),
  ('SYSTEM_PROMPT',              null, false)
on conflict (key) do nothing;
