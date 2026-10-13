-- =============================================================
-- 0065_alert_kinds_webhook.sql
-- Suma los kinds `inbound_dropped` y `kommo_webhook_disabled` a los avisos que se
-- empujan al webhook de alertas (Slack/Discord).
--
-- kommo-webhook ahora RESPONDE PRIMERO y persiste después, en waitUntil: es lo
-- que impide que Kommo deshabilite el webhook cuando Postgres tiene un hipo. El
-- precio es que si el insert falla las 3 veces ese payload se pierde (Kommo ya
-- recibió su 200): la alerta `inbound_dropped` lo hace visible y esta migración
-- asegura que además SALGA al webhook. `kommo_webhook_disabled` es el apagón
-- CONFIRMADO por la API de Kommo (inbound_silence solo lo infiere por ausencia).
-- Los avisos son además `salesbot_not_delivered` (publish-to-kommo) en el panel.
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
    'kommo_webhook_disabled'
  ]::text[];

update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'inbound_dropped')
 where not ('inbound_dropped' = any(webhook_kinds));

update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'kommo_webhook_disabled')
 where not ('kommo_webhook_disabled' = any(webhook_kinds));
