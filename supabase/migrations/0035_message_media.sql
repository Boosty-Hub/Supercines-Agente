-- =============================================================
-- 0035_message_media.sql — URL y tipo del adjunto en messages
-- Permite: (a) mostrar la imagen/archivo real en el inbox del
-- dashboard, (b) re-clasificar adjuntos tras una falla transitoria
-- (créditos/API caída) porque la URL queda persistida.
-- =============================================================
alter table messages add column if not exists media_url text;
alter table messages add column if not exists media_kind text;
