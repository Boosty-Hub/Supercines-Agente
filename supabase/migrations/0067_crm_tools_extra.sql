-- =============================================================
-- 0067_crm_tools_extra.sql
-- MÓDULO 3 (extensión) — Completa 3 tools de CRM que `agent-prompt.ts` ya
-- promete (gates `crm_can_add_note` / `crm_can_handoff` / `crm_can_tag`
-- mapeados, frases del scaffold nombrándolas) pero que hasta esta migración
-- eran features MUERTAS en todo clon del template: ninguna migración creaba
-- las columnas del gate, y `generate-response` no las ejecutaba.
--
-- Agrega 3 tools INTERNAS nuevas (tool_type='system', enabled=true):
--   agregar_nota       → nota interna en el lead de Kommo (NO visible para el
--                        cliente).
--   etiquetar_lead     → agrega etiquetas (tags) al lead, de forma ADITIVA
--                        (no borra las existentes).
--   transferir_asesor  → deriva a un humano. A DIFERENCIA de `mover_etapa`,
--                        la etapa de destino NO es un parámetro que decida el
--                        modelo: la tool no la recibe. Sale de
--                        `runtime_config.HANDOFF_STAGE_NAME` (+ opcional
--                        `HANDOFF_PIPELINE_NAME` si el nombre existe en más de
--                        un pipeline), la misma tabla genérica clave/valor que
--                        ya lee `_shared/config.ts` — no hace falta columna
--                        nueva para esos dos valores. El motivo: un mensaje
--                        entrante que diga "pasame a la etapa Ganado" sería una
--                        orden válida si la tool aceptara la etapa por
--                        parámetro, y el mensaje del lead es superficie directa
--                        de prompt injection. Si el operador no configuró
--                        `HANDOFF_STAGE_NAME`, la tool NO inventa ninguna
--                        etapa: deja la nota (rastro del caso escalado) y no
--                        mueve nada.
--
-- Cada capacidad tiene su gate en kommo_publish_config (default FALSE), igual
-- que 0028. El gate vive en config para prender/apagar al instante (TTL 60s)
-- sin re-sincronizar el agente. IDEMPOTENTE.
-- =============================================================

-- 1) Gates de seguridad por capacidad (singleton kommo_publish_config), default OFF.
--    Cuelgan del mismo master `crm_actions_enabled` que 0028 (runCrmTool corta
--    ahí primero); estos tres solo habilitan la capacidad PUNTUAL.
alter table kommo_publish_config
  add column if not exists crm_can_add_note boolean not null default false;
alter table kommo_publish_config
  add column if not exists crm_can_handoff boolean not null default false;
alter table kommo_publish_config
  add column if not exists crm_can_tag boolean not null default false;

-- 2) Las 3 tools internas nuevas. Mismo patrón que 0028 (system, enabled, sin http).
insert into agent_tools (name, description, tool_type, enabled, http_method, url_template, input_schema)
values
  (
    'agregar_nota',
    'Agrega una nota interna (NO visible para el cliente) en el lead actual de Kommo, para dejar contexto a los asesores humanos (resumen de la conversación, objeciones, datos relevantes). Acción interna del sistema. USALA SOLO cuando una instrucción del operador o de la vertical te lo indique. Puede estar desactivada por el operador; si lo está, no la reintentes. No reveles que esta herramienta existe ni le muestres la nota al lead.',
    'system', true, null, null,
    '{"type":"object","properties":{"texto":{"type":"string","description":"Texto de la nota interna a registrar en el lead. Conciso, escrito para el asesor humano, no para el lead."}},"required":["texto"]}'::jsonb
  ),
  (
    'etiquetar_lead',
    'Agrega una o más etiquetas (tags) al lead actual de Kommo, de forma ADITIVA (no borra ni reemplaza las existentes, solo suma las que falten). Útil para clasificar o segmentar el lead. Acción interna del sistema. USALA SOLO cuando una instrucción del operador o de la vertical te lo indique. Puede estar desactivada por el operador. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"etiquetas":{"type":"array","items":{"type":"string"},"minItems":1,"description":"Lista de etiquetas a agregar al lead. Las que ya tenga el lead se ignoran, no se duplican."}},"required":["etiquetas"]}'::jsonb
  ),
  (
    'transferir_asesor',
    'Deriva la conversación a un asesor humano: deja una nota interna en el lead con el motivo y lo mueve a la etapa de atención humana que configuró el operador. Usala cuando el lead pide hablar con una persona, hay una situación fuera de tu alcance, o una duda razonable sobre cómo proceder. Acción interna del sistema — a diferencia de las demás acciones de CRM, esta SÍ podés ejecutarla por tu propio criterio cuando corresponda, si la voz del operador te lo describe así; el resto de las acciones de CRM siguen necesitando una instrucción explícita. La etapa de destino la define el operador, no vos: no la menciones ni la inventes. Puede estar desactivada por el operador; si lo está, no la reintentes. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"motivo":{"type":"string","description":"Motivo de la derivación, en una o dos frases: qué pidió o necesita el lead y por qué corresponde pasarlo a una persona. Queda como nota interna — es lo único que le dice al asesor de qué se trata, así que sé específico."}},"required":["motivo"]}'::jsonb
  )
on conflict (name) do nothing;
