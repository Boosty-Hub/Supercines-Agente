-- =============================================================
-- 0055_routing_term_correction.sql
-- Corrección de un ruteo hecho a ciegas.
--
-- El round robin se usa cuando el mensaje NO nombra ningún término (la sede).
-- Es una suposición razonable, pero es una suposición. Si dos mensajes después
-- el lead dice "la quiero en La Cascada", la sede es DATO y gana sobre la
-- suposición — si no, el CRM diría una cosa y el agente (que comparte el
-- contacto de la asesora de esa sede) diría otra.
--
-- Guardamos CÓMO se ruteó para poder distinguir:
--   'term_match'  → decisión con dato: NO se toca nunca más.
--   'round_robin' → suposición: se corrige UNA vez si aparece el término, y
--                   solo si el responsable sigue siendo el que pusimos nosotros
--                   (si una persona lo tomó a mano, se respeta y no se toca).
--
-- IDEMPOTENTE.
-- =============================================================

alter table leads
  add column if not exists routed_strategy text;

comment on column leads.routed_strategy is
  'Cómo se asignó el lead: term_match (dato, definitivo) | round_robin (suposición, corregible si luego aparece el término).';

-- Backfill de los leads ya ruteados por 0052: se toma la última decisión
-- registrada en la auditoría. Sin esto quedarían con estrategia NULL y el
-- corrector no sabría si puede tocarlos (por seguridad, NULL = no tocar).
update leads l
set routed_strategy = e.strategy
from (
  select distinct on (lead_id) lead_id, strategy
  from lead_routing_events
  where strategy in ('term_match', 'round_robin')
  order by lead_id, created_at desc
) e
where e.lead_id = l.id
  and l.routed_at is not null
  and l.routed_strategy is null;
