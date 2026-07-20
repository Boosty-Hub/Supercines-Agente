-- =============================================================
-- 0050_messages_kommo_id_unique.sql
-- Dedupe de webhooks de Kommo: índice único (mejor esfuerzo) sobre
-- messages.kommo_message_id.
--
-- PROBLEMA: messages.kommo_message_id no tenía unique y el insert de
-- process-inbound no verificaba existencia → un webhook re-entregado por
-- Kommo (timeout/5xx del endpoint, doble suscripción) creaba una fila
-- nueva que se clasificaba de nuevo (Haiku) y podía disparar OTRA
-- respuesta al mismo mensaje del lead (doble costo + doble mensaje).
--
-- FIX en dos capas:
--   1. process-inbound ahora chequea kommo_message_id antes de insertar
--      (guarda de aplicación — funciona aunque este índice no exista).
--   2. Este índice único parcial cierra la ventana de carrera. MEJOR
--      ESFUERZO: si un deployment viejo ya tiene duplicados históricos,
--      la creación falla y se deja constancia con un NOTICE en vez de
--      bloquear toda la migración (la guarda de aplicación sigue
--      protegiendo hacia adelante). Limpiar los duplicados a mano y
--      re-correr la migración lo deja creado.
-- IDEMPOTENTE.
-- =============================================================

-- Índice de lookup INCONDICIONAL (no único): la guarda de aplicación hace un
-- SELECT por kommo_message_id en CADA mensaje entrante, para siempre. Si el
-- índice único de abajo no puede crearse (duplicados históricos), sin este
-- btree el SELECT haría table scan sobre la tabla que más crece del sistema.
create index if not exists idx_messages_kommo_message_id
  on messages (kommo_message_id)
  where kommo_message_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'messages_kommo_message_id_uniq'
  ) then
    create unique index messages_kommo_message_id_uniq
      on messages (kommo_message_id)
      where kommo_message_id is not null;
  end if;
exception when others then
  raise notice 'messages_kommo_message_id_uniq NO creado (¿duplicados históricos?): %. La guarda de aplicación en process-inbound sigue activa.', sqlerrm;
end $$;
