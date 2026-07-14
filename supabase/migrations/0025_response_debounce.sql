-- =============================================================
-- 0025_response_debounce.sql
-- Tiempo de espera (debounce) configurable antes de responder. Cuando un lead
-- manda varios mensajes seguidos, el agente espera N segundos de silencio desde
-- el último y recién ahí responde TODOS juntos en un solo draft (con contexto).
-- Antes estaba hardcodeado en 45s dentro de generate-response.
-- Additivo e idempotente. Se configura desde /agent → Filtros.
-- =============================================================

alter table kommo_publish_config
  add column if not exists response_debounce_seconds integer not null default 45;
