-- =============================================================
-- 0081_supercines_alert_kinds_existing_config.sql
-- Propia de SuperCines. 0076 (barrido de alertas al webhook) suma a las configuraciones
-- EXISTENTES solo los tipos que eran nuevos en la producción del template. La producción de
-- SuperCines es anterior: su alert_config.webhook_kinds es el default viejo
-- {draft_failed, human_review_needed, outcomes_regression, inbound_silence}, así que además
-- de lo que suma 0076 le faltan estos tipos, que ahí tampoco existían (nadie pudo haberlos
-- quitado, agregarlos no contradice ninguna elección del operador) y que son los que avisan
-- de un agente MUDO:
--   inbound_dropped, kommo_webhook_disabled, budget_exceeded (alertas) y
--   kommo_webhook_caido, kommo_token, ingesta_detenida, cola_atascada (incidentes de salud).
-- Los 4 tipos que ya tenía NO se tocan: si el operador quitó alguno, sigue quitado.
-- array_append solo si falta → IDEMPOTENTE. Debe correr después de 0076.
-- =============================================================
do $$
declare
  k text;
begin
  foreach k in array array[
    'inbound_dropped', 'kommo_webhook_disabled', 'budget_exceeded',
    'kommo_webhook_caido', 'kommo_token', 'ingesta_detenida', 'cola_atascada'
  ]::text[] loop
    update alert_config set webhook_kinds = array_append(webhook_kinds, k) where not (k = any(webhook_kinds));
  end loop;
end $$;
