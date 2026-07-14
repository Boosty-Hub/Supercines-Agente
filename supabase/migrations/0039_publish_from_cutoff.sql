-- =============================================================
-- 0039_publish_from_cutoff.sql
-- Línea de corte de publicación. El publicador (publish-to-kommo) solo envía
-- drafts creados DESPUÉS de este timestamp. Hace seguro el paso
-- validación→producción: los borradores generados en modo validación
-- (mientras los asesores respondían a mano en Kommo) NO se disparan al activar
-- el salesbot/publicación.
--
--   null  → comportamiento legacy: publica todo approved+unsent (no rompe vivos).
--   fecha → solo publica drafts con created_at >= publish_from.
--
-- Se estampa UNA sola vez, desde /api/settings/kommo, cuando el sistema queda
-- por primera vez habilitado para publicar de verdad (publishing_enabled=true
-- Y salesbot_id configurado Y publish_from todavía null) = el go-live real.
-- IDEMPOTENT.
-- =============================================================

alter table kommo_publish_config
  add column if not exists publish_from timestamptz;
