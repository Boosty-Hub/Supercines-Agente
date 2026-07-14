-- =============================================================
-- 0032_business_hours_per_day.sql
-- Horario laboral POR DÍA: "Lun-Vie 9-21, Sáb 9-13" en vez de un único
-- rango para todos los días activos.
--
-- Modelo: follow_up_config.business_hours jsonb
--   { "1": {"start":"09:00","end":"21:00"}, ..., "6": {"start":"09:00","end":"13:00"} }
--   - key = ISODOW como texto (1=Lun .. 7=Dom); día ausente = cerrado.
--   - Rango [start, end) en hora local del timezone del config.
--   - NULL = usar las columnas legacy (business_hours_start/end + active_days),
--     así los despliegues existentes siguen funcionando sin tocar nada.
--
-- Consumidores (todos con el mismo fallback):
--   - follow_up_due_leads (esta función, gate SQL de los seguimientos)
--   - generate-response (en_horario_laboral en el contexto del agente)
--   - el editor en /agent → Filtros (escribe jsonb + deriva legacy)
-- =============================================================

alter table follow_up_config
  add column if not exists business_hours jsonb;

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
    -- stage de Kommo no es stop stage (null stage pasa — graceful para leads viejos)
    and (
      cardinality(cfg.stop_stage_ids) = 0
      or l.kommo_stage_id is null
      or not (l.kommo_stage_id = any(cfg.stop_stage_ids))
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
