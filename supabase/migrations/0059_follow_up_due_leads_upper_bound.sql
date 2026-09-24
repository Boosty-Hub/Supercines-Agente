-- =============================================================
-- 0059_follow_up_due_leads_upper_bound.sql
-- Techo de 72h en follow_up_due_leads: un seguimiento que quedó pendiente
-- por demasiado tiempo ya no se dispara solo.
--
-- PROBLEMA: follow_up_due_leads solo chequea el PISO (now() - ... >=
-- delay_hours) — nunca un TECHO. Si el sistema estuvo `system_halted` o
-- `agent_enabled=false` varios días, al reactivarse TODOS los leads cuyo
-- delay venció durante la pausa quedan "debidos" de una — y follow-up-scan
-- les dispara una plantilla de WhatsApp vieja y fuera de contexto a leads
-- que capaz ya se fueron, ya los atendió un asesor, o ya perdieron interés.
--
-- FIX: agrega un techo — si pasaron más de 72h desde que el seguimiento se
-- volvió elegible (delay_hours cumplido), ya no se dispara. 72h = el cierre
-- de fin de semana más largo del negocio (viernes tarde → lunes mañana),
-- así un fin de semana normal no se come seguimientos legítimos. Sin
-- mutación de estado: si el lead escribe de nuevo, last_inbound_at se
-- mueve y la secuencia sigue su curso normal desde ese momento.
--
-- IDEMPOTENTE (create or replace, misma firma que 0049 → sin drop).
-- Reescribe la versión viva de 0049 (cooldown de skip + lista blanca de
-- etapas + horario por día), agregando ÚNICAMENTE el techo de 72h.
-- Mantener sincronizado con 0049 si la lógica de etapas/horario cambia.
-- =============================================================

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
    -- techo (0059): si el seguimiento se volvió elegible hace más de 72h
    -- (delay_hours cumplido + 72h de margen), ya venció — no se dispara
    -- solo tras una pausa larga. Sin esto, reactivar el sistema tras varios
    -- días disparaba de una todos los seguimientos acumulados.
    and now() - coalesce(l.follow_up_last_sent_at, l.last_inbound_at)
          < make_interval(hours => ns.delay_hours) + interval '72 hours'
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

-- Menor privilegio (estándar de seguridad de Boosty): Postgres le da EXECUTE
-- a PUBLIC por defecto y esta función nunca lo restringió. El único caller
-- es follow-up-scan con la key de servicio (grep en web/src: ningún caller
-- desde el dashboard) — nadie más tiene por qué poder correr esta RPC.
revoke execute on function follow_up_due_leads(int) from public, anon, authenticated;
grant execute on function follow_up_due_leads(int) to service_role;
