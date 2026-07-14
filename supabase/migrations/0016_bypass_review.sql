-- =============================================================
-- 0016_bypass_review.sql
-- Bypass de revisión: si bypass_review=true (y publishing_enabled=
-- true), el agente responde y publica SIEMPRE, aun cuando el
-- mensaje o la vertical entrarían a revisión humana. Solo tiene
-- efecto con publishing habilitado.
-- =============================================================

alter table kommo_publish_config
  add column if not exists bypass_review boolean not null default false;
