-- =============================================================
-- 0041_follow_up_run_users.sql
-- Lista blanca de USUARIOS RESPONSABLES (vendedores) donde corre el seguimiento.
-- Espeja a run_stage_ids (0038) pero por responsible_user_id del lead en Kommo.
--
-- Semántica de run_user_ids:
--   - vacío  → corre para leads de TODOS los responsables (default; no rompe
--     despliegues vivos).
--   - con N usuarios → corre SOLO si el responsable real del lead está en la lista.
--
-- A diferencia de run_stage_ids, este filtro NO se aplica en el gate SQL (no
-- guardamos responsible_user_id en leads): se aplica en follow-up-scan con el
-- valor EN VIVO de Kommo (mismo GET /api/v4/leads/{id} que ya verifica la etapa,
-- así que no agrega requests). El gate SQL sigue pre-filtrando por etapa.
--
-- IDEMPOTENT.
-- =============================================================

alter table follow_up_config
  add column if not exists run_user_ids bigint[] not null default '{}'::bigint[];
