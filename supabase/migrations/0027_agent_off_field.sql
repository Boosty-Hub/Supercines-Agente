-- =============================================================
-- 0027_agent_off_field.sql
-- Interruptor "Apagar Agente" por lead: el operador elige (por NOMBRE) un campo
-- custom de Kommo tipo casilla. Si en la ficha del lead ese campo está encendido,
-- el agente NO responde a ese lead (kill switch manual desde Kommo, reemplaza el
-- patrón de tags stop_ai). Default null = desactivado.
--   agent_off_field_id   → id del campo en Kommo (se resuelve por nombre en la UI)
--   agent_off_field_name → nombre para mostrar en el dashboard
-- =============================================================

alter table kommo_publish_config
  add column if not exists agent_off_field_id bigint;
alter table kommo_publish_config
  add column if not exists agent_off_field_name text;
