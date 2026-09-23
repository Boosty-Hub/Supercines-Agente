-- =============================================================
-- 0057_system_halted.sql
-- Apagado total del sistema: un solo switch que corta CUALQUIER llamada a
-- proveedores de IA (Anthropic/OpenAI) Y cualquier mensaje saliente
-- automático hacia Kommo.
--
-- `agent_enabled` (0015) es un kill switch que SOLO gatea generate-response.
-- Con el agente "apagado" por ese switch, process-inbound seguía
-- clasificando con Haiku, dreams-run seguía destilando con Sonnet,
-- evaluate-outcomes seguía corriendo los graders LLM, y follow-up-scan
-- seguía disparando la sesión CMA completa por cada seguimiento — todos
-- gastando tokens mientras el operador cree que "apagó el agente". Y
-- publish-to-kommo seguía entregando a Kommo los drafts que ya estaban
-- aprobados, así que además del gasto, los mensajes automáticos seguían
-- saliendo por WhatsApp/Instagram.
--
-- system_halted lo chequean las SEIS funciones de arriba, lo antes posible
-- en su flujo, antes de gastar un token o de publicar nada. Ver
-- `_shared/halt.ts` para el porqué de incluir publish-to-kommo (más amplio
-- que solo "llama a un proveedor de IA": un kill switch total que deja
-- salir mensajes ya aprobados no cumple lo que promete). IDEMPOTENTE.
-- =============================================================

alter table kommo_publish_config
  add column if not exists system_halted boolean not null default false;

comment on column kommo_publish_config.system_halted is
  'Apagado total: si es true, NINGUNA Edge Function llama a un proveedor de IA (Anthropic/OpenAI) ni publica nada a Kommo. Más amplio que agent_enabled, que solo corta generate-response.';

-- ── Trazabilidad ────────────────────────────────────────────────────────────
-- Un apagado total se prende en una emergencia, casi siempre por alguien que
-- no es quien después pregunta «¿y esto por qué está apagado?». Sin estas dos
-- columnas la respuesta vive en el chat de alguien, o en ningún lado, y el
-- sistema se queda frenado más tiempo del necesario porque nadie se anima a
-- reactivar algo que no sabe por qué se frenó.
--
-- `halted_by` referencia `auth.users` igual que `alerts.acknowledged_by`
-- (0011), con `on delete set null`: que se borre el usuario no puede borrar el
-- registro de que el sistema estuvo frenado.
alter table kommo_publish_config
  add column if not exists halted_at timestamptz;
alter table kommo_publish_config
  add column if not exists halted_by uuid references auth.users(id) on delete set null;
alter table kommo_publish_config
  add column if not exists halted_reason text;

comment on column kommo_publish_config.halted_at is
  'Cuándo se activó el apagado total. Se conserva después de reactivar: sirve para reconstruir el incidente.';
comment on column kommo_publish_config.halted_reason is
  'Motivo que escribió quien frenó el sistema. Es lo que le permite a otra persona decidir si ya se puede reactivar.';
