-- =============================================================
-- 0028_crm_tools.sql
-- MÓDULO 3 — El agente OPERA el CRM (por NOMBRE, no por IDs).
--
-- Agrega 3 tools INTERNAS (tool_type='system') que todos los clones tienen:
--   mover_etapa         → mueve el lead a otra etapa del pipeline (por nombre)
--   actualizar_lead     → completa un campo custom del LEAD (por nombre)
--   actualizar_contacto → completa un campo custom del CONTACTO (por nombre)
--
-- Modelo HÍBRIDO (decisión del usuario): el agente SIEMPRE tiene las tools y
-- SABE que puede hacerlo, pero solo ACTÚA cuando una instrucción del operador
-- (su voz/dreams) o de la vertical activa se lo indica. La ejecución está
-- protegida por un gate de seguridad a RUNTIME (flags abajo), default OFF.
--
-- Las tools se seedean enabled=true → buildAgentTools() las empuja a Anthropic
-- en el próximo sync (igual que search_kb). El gate vive en kommo_publish_config
-- para poder prender/apagar al instante SIN re-sincronizar el agente
-- (generate-response lee los flags con TTL 60s).
--
-- IDEMPOTENTE: ON CONFLICT DO NOTHING + add column if not exists.
-- =============================================================

-- 1) Gate de seguridad por capacidad (singleton kommo_publish_config).
--    Default FALSE: el agente NO toca el CRM hasta que el operador lo active.
alter table kommo_publish_config
  add column if not exists crm_actions_enabled boolean not null default false;
alter table kommo_publish_config
  add column if not exists crm_can_move_stage boolean not null default false;
alter table kommo_publish_config
  add column if not exists crm_can_update_lead boolean not null default false;
alter table kommo_publish_config
  add column if not exists crm_can_update_contact boolean not null default false;

-- 2) Las 3 tools internas. Mismo patrón que search_kb (system, enabled, sin http).
insert into agent_tools (name, description, tool_type, enabled, http_method, url_template, input_schema)
values
  (
    'mover_etapa',
    'Mueve el lead actual a otra etapa del pipeline de Kommo, identificada POR NOMBRE (ej: "Negociación", "Ganado"). Acción interna del sistema. USALA SOLO cuando una instrucción explícita del operador (su voz/dreams) o de la vertical activa te lo indique — NUNCA por iniciativa propia. Puede estar desactivada por el operador; si lo está, no la uses. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"stage_name":{"type":"string","description":"Nombre EXACTO de la etapa del pipeline de Kommo a la que mover el lead, tal como aparece en Kommo."},"pipeline_name":{"type":"string","description":"Opcional. Nombre del pipeline si la etapa existe en varios pipelines. Si se omite, se usa la primera coincidencia."},"motivo":{"type":"string","description":"Opcional. Motivo breve del cambio de etapa, para el registro."}},"required":["stage_name"]}'::jsonb
  ),
  (
    'actualizar_lead',
    'Completa o actualiza un campo del LEAD en Kommo, identificado POR NOMBRE (ej: "Presupuesto", "Ciudad"). Acción interna del sistema. USALA SOLO cuando una instrucción del operador o de la vertical te lo pida explícitamente — nunca por iniciativa propia. Puede estar desactivada por el operador. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"field_name":{"type":"string","description":"Nombre EXACTO del campo del LEAD en Kommo a completar, tal como aparece en Kommo."},"value":{"type":"string","description":"Valor a escribir en el campo."}},"required":["field_name","value"]}'::jsonb
  ),
  (
    'actualizar_contacto',
    'Completa o actualiza un campo del CONTACTO del lead en Kommo, identificado POR NOMBRE (ej: "Email", "Cumpleaños"). Acción interna del sistema. USALA SOLO cuando se te indique explícitamente (operador o vertical) — nunca por iniciativa propia. Puede estar desactivada por el operador. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"field_name":{"type":"string","description":"Nombre EXACTO del campo del CONTACTO en Kommo a completar, tal como aparece en Kommo."},"value":{"type":"string","description":"Valor a escribir en el campo."}},"required":["field_name","value"]}'::jsonb
  )
on conflict (name) do nothing;
