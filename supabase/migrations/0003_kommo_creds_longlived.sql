-- =============================================================
-- 0003_kommo_creds_longlived.sql
-- Adapta kommo_credentials al modo long-lived token (sin OAuth).
-- =============================================================

-- Hacer refresh_token nullable (long-lived tokens no traen refresh)
alter table kommo_credentials
  alter column encrypted_refresh_token drop not null;

-- Agregar api_domain (cada cuenta tiene su endpoint)
alter table kommo_credentials
  add column if not exists api_domain text;

-- Agregar account_id (id numérico de la cuenta Kommo)
alter table kommo_credentials
  add column if not exists account_id bigint;
