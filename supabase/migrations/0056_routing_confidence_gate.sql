-- =============================================================
-- 0056_routing_confidence_gate.sql
-- Umbral de confianza para rutear.
--
-- CASO REAL que motiva esto (14-ago-2026): una conversación INTERNA de staff
-- por WhatsApp (facturas de Coca-Cola, un chofer, una camioneta) se clasificó
-- como 'eventos_corporativo' con confidence 0.65 — el propio razonamiento del
-- clasificador decía "logística corporativa NO relacionada con SUPERCINES" — y
-- el ruteo le asignó el lead a una asesora y le estampó "Alquiler de Salas".
--
-- Clasificar con dudas es barato y reversible: un mensaje mal categorizado no
-- le hace nada a nadie. ESCRIBIR EN EL CRM no: le mete un lead falso a una
-- persona real y le ensucia el embudo. Las dos decisiones no pueden compartir
-- el mismo nivel de exigencia.
--
-- routing_min_confidence: confianza mínima de la clasificación para que el
--   ruteo actúe. 0 = sin umbral (comportamiento anterior). Default 0.80.
--   Por debajo del umbral NO se marca el lead como ruteado: si más adelante
--   llega un mensaje claro, se rutea ahí.
--
-- IDEMPOTENTE.
-- =============================================================

alter table kommo_publish_config
  add column if not exists routing_min_confidence numeric(3,2) not null default 0.80;

comment on column kommo_publish_config.routing_min_confidence is
  'Confianza mínima de la clasificación (0-1) para que el ruteo asigne responsable y escriba en Kommo. 0 = sin umbral.';
