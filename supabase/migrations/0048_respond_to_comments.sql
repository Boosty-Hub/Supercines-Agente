-- 0048: gate para responder comentarios de Instagram (la respuesta por DM).
--
-- GAP que cierra: el toggle comment_reply_enabled (0037) SOLO gatea la
-- respuesta PÚBLICA en el comentario; la respuesta por DM corría SIEMPRE
-- (sesión CMA completa por cada comentario, sin switch para apagarla).
-- En KIA (julio 2026) el 97% de esas respuestas falló la entrega
-- ("salesbot disparado pero sin entrega confirmada") → costo sin valor.
--
-- respond_to_comments (default OFF — responder comentarios es opt-in):
--   - OFF: process-inbound marca el mensaje ignored (comments_off) SIN
--     clasificar (cero tokens) y generate-response filtra los comentarios
--     del batch como red de seguridad (backlog pre-gate y carreras).
--   - ON: pipeline completo por DM; comment_reply_enabled agrega además
--     la respuesta pública corta.
-- Apagar el gate fuerza comment_reply_enabled=false (cascada en el route
-- /api/agent/comments, espejo del master gate de CRM).
-- IDEMPOTENTE.

alter table kommo_publish_config
  add column if not exists respond_to_comments boolean not null default false;

comment on column kommo_publish_config.respond_to_comments is
  'OFF: los comentarios detectados (comment_source_ids) se ignoran sin clasificar ni responder. ON: respuesta por DM (pipeline completo); comment_reply_enabled agrega además la respuesta pública.';
