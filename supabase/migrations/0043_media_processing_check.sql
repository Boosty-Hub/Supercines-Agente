-- Verificación de procesamiento de adjuntos.
--
-- Hasta ahora, si una nota de voz no se podía transcribir (o una imagen /
-- documento no se podía leer), el fallo solo quedaba en un console.error de la
-- Edge Function: el mensaje entraba como "[Audio file.ogg]" y nadie se
-- enteraba. Un bug de redirects hizo que TODAS las notas de voz fallaran en
-- silencio durante días, perdiendo leads reales.
--
-- media_status registra el resultado del procesamiento de cada adjunto para
-- que sea auditable desde el dashboard y para que alerts-scan pueda avisar.

alter table messages
  add column if not exists media_status text
    check (media_status in ('ok', 'failed', 'skipped'));

-- Detalle legible del fallo o del salteo (ej. "whisper 401", "media_audio_off").
alter table messages
  add column if not exists media_error text;

comment on column messages.media_status is
  'Resultado del procesamiento del adjunto: ok = transcrito/descrito, failed = se intentó y falló, skipped = deshabilitado por configuración. NULL = mensaje sin adjunto.';

-- Índice para el escaneo de alertas y para el panel: solo los que fallaron.
create index if not exists messages_media_failed_idx
  on messages(created_at desc)
  where media_status = 'failed';
