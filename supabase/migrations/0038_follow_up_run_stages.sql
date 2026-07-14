-- =============================================================
-- 0038_follow_up_run_stages.sql
-- Invierte el gating de etapas del seguimiento: de "etapas que DETIENEN"
-- (lista negra, stop_stage_ids, pegadas a mano como IDs) a "etapas donde SÍ
-- corre" (lista blanca, run_stage_ids, elegidas de un selector del embudo).
--
-- Semántica de run_stage_ids:
--   - vacío  → corre en TODAS las etapas (default; no rompe despliegues vivos,
--     idéntico al comportamiento de stop_stage_ids vacío de hoy).
--   - con N etapas → corre SOLO si el lead está en una de ellas. Un lead sin
--     etapa conocida (kommo_stage_id null) NO matchea → no se le hace seguimiento.
--     Es deliberadamente restrictivo: el operador suele acotar a 1-2 etapas.
--
-- stop_stage_ids queda como columna dormida (NO se borra — migraciones no
-- destructivas) pero ya no se usa en el gate ni en la UI.
--
-- IDEMPOTENT. Reescribe follow_up_due_leads sobre la versión viva de 0032
-- (horario laboral por día), cambiando ÚNICAMENTE el bloque de etapa.
-- Mantener este archivo sincronizado con 0032 si la lógica de horario cambia.
-- =============================================================

alter table follow_up_config
  add column if not exists run_stage_ids bigint[] not null default '{}'::bigint[];

create or replace function follow_up_due_leads(p_limit int default 5)
returns table(
  lead_id     uuid,
  step_number int,
  delay_hours int,
  template_id uuid
) language sql stable as $$
  select
    l.id            as lead_id,
    ns.step_number,
    ns.delay_hours,
    ns.template_id
  from leads l
  join follow_up_config cfg
       on  cfg.is_active = true
       and cfg.enabled   = true
  join follow_up_steps ns
       on  ns.step_number = l.follow_up_step + 1
       and ns.enabled     = true
  where
    -- no está en estado terminal
    l.follow_up_status is distinct from 'responded'
    and l.follow_up_status is distinct from 'exhausted'
    and l.follow_up_status is distinct from 'stopped'
    -- opted_out es stop duro
    and coalesce(l.opted_out, false) = false
    -- etapa de Kommo (lista blanca): vacía = todas las etapas; con etapas, el
    -- lead debe estar en una de ellas. null stage NO matchea (= any(...) da null)
    -- → no se le hace seguimiento, comportamiento restrictivo a propósito.
    and (
      cardinality(cfg.run_stage_ids) = 0
      or l.kommo_stage_id = any(cfg.run_stage_ids)
    )
    -- aún no superó el máximo de seguimientos
    and l.follow_up_step < cfg.max_follow_ups
    -- reloj de inactividad: desde el último envío o desde el primer inbound
    and now() - coalesce(l.follow_up_last_sent_at, l.last_inbound_at)
          >= make_interval(hours => ns.delay_hours)
    -- piso mínimo entre envíos
    and (
      l.follow_up_last_sent_at is null
      or now() - l.follow_up_last_sent_at >= make_interval(hours => cfg.min_gap_hours)
    )
    -- siempre necesitamos un baseline de inbound (nunca iniciar secuencia sin contexto)
    and l.last_inbound_at is not null
    -- gate de horario laboral: por-día (jsonb) si existe, si no legacy
    and (
      case
        when cfg.business_hours is not null then
          cfg.business_hours ? extract(isodow from now() at time zone cfg.timezone)::int::text
          and (now() at time zone cfg.timezone)::time
                >= ((cfg.business_hours -> (extract(isodow from now() at time zone cfg.timezone)::int::text)) ->> 'start')::time
          and (now() at time zone cfg.timezone)::time
                <  ((cfg.business_hours -> (extract(isodow from now() at time zone cfg.timezone)::int::text)) ->> 'end')::time
        else
          extract(hour from now() at time zone cfg.timezone)::int >= cfg.business_hours_start
          and extract(hour from now() at time zone cfg.timezone)::int < cfg.business_hours_end
          and extract(isodow from now() at time zone cfg.timezone)::int = any(cfg.active_days)
      end
    )
  order by coalesce(l.follow_up_last_sent_at, l.last_inbound_at) asc
  limit p_limit;
$$;
