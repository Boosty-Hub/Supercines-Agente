-- =============================================================
-- 0068_alert_kind_outbound_blocked.sql
-- `outbound_blocked`: el verificador de texto saliente (_shared/outbound.ts) frenó
-- la respuesta PÚBLICA a un comentario o un seguimiento automático porque traían
-- residuo interno del agente. Sale también al webhook de alertas (Slack/Discord).
-- IDEMPOTENTE.
-- =============================================================
alter table alert_config
  alter column webhook_kinds
  set default array[
    'draft_failed',
    'human_review_needed',
    'outcomes_regression',
    'inbound_silence',
    'budget_exceeded',
    'inbound_dropped',
    'kommo_webhook_disabled',
    'outbound_blocked'
  ]::text[];

update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'outbound_blocked')
 where not ('outbound_blocked' = any(webhook_kinds));
