-- =============================================================
-- 0024_filter_targets.sql
-- Escala los filtros de "no responder" a más dimensiones:
--   - ignored_channels   → canales (waba/instagram/tiktok_kommo/onlinechat…)
--                          en los que el agente NO responde. Se evalúa en
--                          process-inbound (marca messages.ignored).
--   - ignored_stage_ids  → etapas (status_id de Kommo) en las que el agente
--                          NO atiende. Se evalúa en generate-response (gate
--                          por lead, como el cooldown). null stage = atiende.
-- Additivo e idempotente. Se configura desde /agent → Filtros.
-- =============================================================

alter table kommo_publish_config
  add column if not exists ignored_channels text[] not null default '{}'::text[];

alter table kommo_publish_config
  add column if not exists ignored_stage_ids bigint[] not null default '{}'::bigint[];
