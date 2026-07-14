-- =============================================================
-- 0026_media_response.sql
-- Permite que el agente RESPONDA a adjuntos que envía el lead:
--   - respond_to_images     → fotos/imágenes (visión nativa de Claude)
--   - respond_to_documents  → PDFs (document blocks nativos de Claude)
--   - respond_to_audio      → audios (REQUIERE transcripción externa; aún no
--                             implementado — columna reservada para fase 2)
-- Todo ships DESACTIVADO (opt-in). Se configura desde /agent → Filtros.
-- =============================================================

alter table kommo_publish_config
  add column if not exists respond_to_images boolean not null default false;
alter table kommo_publish_config
  add column if not exists respond_to_documents boolean not null default false;
alter table kommo_publish_config
  add column if not exists respond_to_audio boolean not null default false;
