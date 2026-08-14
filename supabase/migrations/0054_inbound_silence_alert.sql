-- =============================================================
-- 0054_inbound_silence_alert.sql
-- Suma el kind `inbound_silence` a los avisos que se empujan al webhook
-- de alertas (Slack/Discord).
--
-- Kommo deshabilita un webhook cuyo endpoint le falla de forma sostenida y
-- NO avisa a nadie. En KIA eso dejó el sistema mudo 6 días (jul 30–ago 4) y
-- otros 4 (ago 7–ago 10) sin que saltara nada: los leads escribían y nadie
-- los veía. `alerts-scan` ahora detecta el silencio (cero webhooks en 90 min
-- de horario laboral); esta migración se asegura de que ese aviso también
-- salga por el webhook y no solo al dashboard — es exactamente la alerta que
-- no sirve de nada si hay que ir a buscarla.
-- IDEMPOTENTE.
-- =============================================================

alter table alert_config
  alter column webhook_kinds
  set default array[
    'draft_failed',
    'human_review_needed',
    'outcomes_regression',
    'inbound_silence'
  ]::text[];

-- Configuraciones ya existentes: agregar el kind sin pisar lo que el operador
-- haya elegido (array_append solo si todavía no está).
update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'inbound_silence')
 where not ('inbound_silence' = any(webhook_kinds));
