-- =============================================================
-- 0031_bcv_rate_tool.sql
-- Tool interna: tasa de cambio USD→VES (BCV) para conversiones en el chat.
--
-- Patrón Módulo 3/4: la tool SIEMPRE existe en agent_tools (el agente sabe
-- usarla), pero solo ACTÚA si el operador prende el gate en runtime
-- (kommo_publish_config.bcv_rate_enabled, default OFF).
--
-- Fuente de la tasa (resuelta en runtime por la Edge Function):
--   1. runtime_config.BCV_RATE_URL (+ BCV_RATE_APIKEY opcional) — endpoint
--      propio del operador (ej: RPC get_active_rate en otro Supabase).
--   2. Fallback público sin credenciales (ve.dolarapi.com, tasa oficial BCV).
-- La tasa se cachea en memoria de la función (TTL 6h) — el BCV publica 1/día.
--
-- IDEMPOTENTE: add column if not exists + on conflict do nothing.
-- =============================================================

alter table kommo_publish_config
  add column if not exists bcv_rate_enabled boolean not null default false;

insert into agent_tools (name, description, tool_type, enabled, http_method, url_template, input_schema)
values
  (
    'tasa_bcv',
    'Devuelve la tasa de cambio oficial USD→VES (BCV) vigente, con fuente y fecha de actualización. Acción interna del sistema. USALA cuando el lead pida un precio en bolívares o necesites convertir un monto de dólares a bolívares — solo si la capacidad está activada. Indicá siempre que es un monto aproximado a la tasa BCV del día. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{},"required":[]}'::jsonb
  )
on conflict (name) do nothing;
