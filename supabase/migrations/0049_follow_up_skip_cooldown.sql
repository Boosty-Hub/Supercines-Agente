-- =============================================================
-- 0049_follow_up_skip_cooldown.sql
-- Cooldown para decisiones "skip" del seguimiento automático.
--
-- PROBLEMA: cuando el agente evaluaba un lead elegible y decidía "skip",
-- NO se actualizaba ningún estado ni timestamp → el lead volvía a ser
-- elegible en el PRÓXIMO barrido (cada 5 min) y cada re-evaluación es una
-- sesión CMA completa (memoria montada + modelo). Un lead "atascado" en
-- skip podía quemar hasta 12 sesiones/hora indefinidamente y, como
-- follow_up_due_leads ordena por antigüedad con p_limit=5, ≥5 leads en
-- skip acaparaban el cupo de cada ciclo (starvation de los demás).
--
-- FIX: leads.follow_up_last_skipped_at — follow-up-scan lo sella en cada
-- decisión "skip" (y en salidas malformadas tratadas como skip), y
-- follow_up_due_leads excluye al lead hasta pasada 1 hora del último skip.
-- 1h = 12x menos evaluaciones que el peor caso, manteniendo el seguimiento
-- responsivo dentro del horario laboral.
--
-- IDEMPOTENT. Reescribe follow_up_due_leads sobre la versión viva de 0038
-- (lista blanca run_stage_ids + horario por día de 0032), agregando
-- ÚNICAMENTE el bloque de cooldown de skip. Mantener sincronizado con
-- 0038 si la lógica de etapas/horario cambia.
-- =============================================================

alter table leads
  add column if not exists follow_up_last_skipped_at timestamptz;

comment on column leads.follow_up_last_skipped_at is
  'Último momento en que el agente evaluó este lead para seguimiento y decidió "skip". follow_up_due_leads lo excluye por 1h para no re-evaluarlo (sesión CMA) en cada barrido de 5 min.';

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
    -- cooldown de skip (0049): si el agente ya evaluó y decidió "skip" hace
    -- menos de 1h, no volver a evaluar (cada evaluación = una sesión CMA).
    and (
      l.follow_up_last_skipped_at is null
      or now() - l.follow_up_last_skipped_at >= interval '1 hour'
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
