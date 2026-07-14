-- =============================================================
-- 0037_ig_comments.sql
-- Soporte para comentarios de Instagram: detección automática por source_id
-- del talk de Kommo, contexto para el agente y respuesta pública generada
-- por IA (gobernada por reglas configurables del operador).
-- IDEMPOTENTE. comment_source_ids queda VACÍO por defecto: cada cliente tiene
-- su propio source de comentarios (se descubre consultando GET /api/v4/talks
-- de un comentario real y se configura en el panel de /agent → Acciones).
-- =============================================================

-- ---- Configuración de comentarios en kommo_publish_config ----

alter table kommo_publish_config
  add column if not exists comment_reply_enabled  boolean   not null default false,
  add column if not exists comment_source_ids     bigint[]  not null default '{}',
  add column if not exists comment_salesbot_id    bigint    null,
  add column if not exists comment_field_id       bigint    null,
  add column if not exists comment_reply_rules    text      null,
  add column if not exists comment_instructions   text      null;

-- ---- Marca de comentario en messages ----

alter table messages
  add column if not exists is_comment boolean not null default false;

-- ---- Defaults genéricos (solo si el operador no los definió) ----

update kommo_publish_config
set
  comment_reply_rules  = coalesce(comment_reply_rules, 'Respuesta CORTA (máximo 200 caracteres), sin saludos largos ni presentaciones: directo al grano. NO des precios, montos ni promociones con números en público — para eso invitá al DM ("te pasamos el detalle por DM 💛"). Tono cercano, máximo 1 emoji. Si el comentario es solo elogio o emojis, agradecé breve.'),
  comment_instructions = coalesce(comment_instructions, 'El mensaje vino de un comentario público en una publicación de Instagram. Tu respuesta sale por DM: reconocé el origen con naturalidad (ej: "vi tu comentario 😊"), andá directo al grano.')
where is_active = true;
