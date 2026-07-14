-- =============================================================
-- 0015_agent_enabled.sql
-- Switch independiente del publishing: habilita/deshabilita al
-- agente. agent_enabled=true → el agente responde (drafts en
-- plataforma). publishing_enabled controla aparte si se envía a
-- Kommo. agent_enabled=false → kill switch: no genera nada.
-- =============================================================

alter table kommo_publish_config
  add column if not exists agent_enabled boolean not null default true;
