-- =============================================================
-- 0040_answer_freshness_window.sql
-- Ventana de frescura: el agente SOLO atiende mensajes de las últimas N horas.
-- Lo más viejo se ignora (lo manejan los asesores humanos en Kommo). Evita que,
-- tras una caída o un pico de volumen, el agente arrastre un backlog enorme
-- contestando mensajes viejos mientras los nuevos esperan detrás — el comprador
-- de ahora no debe quedar al fondo de una cola de días.
--
--   N > 0 → solo mensajes con created_at >= now() - N horas (cola fresca).
--   0     → sin límite (legacy: atiende todo el backlog acumulado).
--
-- Default 1h: prioriza siempre la conversación fresca. Aplica SOLO al modo cola
-- (no al camino de revisión humana explícita, que responde el mensaje pedido
-- sin importar su antigüedad).
-- =============================================================

alter table kommo_publish_config
  add column if not exists answer_max_age_hours int not null default 1;
