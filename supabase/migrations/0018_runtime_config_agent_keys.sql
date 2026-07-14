-- =============================================================
-- 0018_runtime_config_agent_keys.sql
-- Adds the agent-provisioning keys the /setup wizard writes when it creates
-- the Anthropic Environment + Managed Agent. Same precedence rule as 0017:
-- NULL/empty → reader falls back to env (pre-wizard parity preserved).
--
-- These were previously read only by scripts/setup-cma-agent.mjs from the root
-- .env.local. The wizard (Phase 3) now collects them and writes them here.
-- Seeded NULL so existing env-only setups keep behaving identically.
-- =============================================================

insert into runtime_config (key, value, is_secret) values
  ('AGENT_ENVIRONMENT_NAME', null, false),
  ('AGENT_MODEL',            null, false),
  ('AGENT_DESCRIPTION',      null, false)
on conflict (key) do nothing;
