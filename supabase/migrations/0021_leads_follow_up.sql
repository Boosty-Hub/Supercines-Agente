-- =============================================================
-- 0021_leads_follow_up.sql
-- Columnas de seguimiento en la tabla leads.
-- IDEMPOTENT: add column if not exists.
-- =============================================================

-- Reloj de inactividad — se actualiza SOLO en inbound.
-- Distinto de last_message_at (que incluye outbound) para que los
-- envíos manuales del operador no reseteen el temporizador.
alter table leads add column if not exists last_inbound_at        timestamptz;

-- Estado de la secuencia de seguimiento del lead.
-- Valores: null (nunca iniciado), active, responded, exhausted, stopped.
alter table leads add column if not exists follow_up_status       text;

-- Número del último paso enviado (0 = ninguno enviado aún).
alter table leads add column if not exists follow_up_step         int not null default 0;

-- Timestamp del último envío de seguimiento (para calcular demoras).
alter table leads add column if not exists follow_up_last_sent_at timestamptz;

-- Si true el lead pidió no ser contactado — stop duro, nunca se sobreescribe.
alter table leads add column if not exists opted_out              boolean not null default false;

-- Etapa de Kommo al momento del último evento — para stop_stage_ids.
-- Null en leads históricos (pasa el gate de elegibilidad por diseño).
alter table leads add column if not exists kommo_stage_id         bigint;

-- Índice de escaneo: la función follow_up_due_leads filtra por estos campos.
create index if not exists leads_follow_up_scan_idx
  on leads(follow_up_status, opted_out, follow_up_step);

-- Índice secundario por reloj de inactividad (para el ORDER BY de la función).
create index if not exists leads_last_inbound_idx
  on leads(last_inbound_at);

-- =============================================================
-- follow_up_due_leads: función SQL de elegibilidad.
-- Vive ACÁ (no en 0020) porque depende de las columnas de `leads` de arriba
-- Y de las tablas follow_up_* de 0020 — debe crearse después de ambas.
-- Toda la lógica de horario y demora vive aquí (Postgres tz-correcto).
-- Retorna 0 filas si el seguimiento está deshabilitado o fuera de horario.
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
    -- gate de horario laboral (zona horaria del config)
    and extract(hour  from now() at time zone cfg.timezone)::int >= cfg.business_hours_start
    and extract(hour  from now() at time zone cfg.timezone)::int <  cfg.business_hours_end
    and extract(isodow from now() at time zone cfg.timezone)::int = any(cfg.active_days)
  order by coalesce(l.follow_up_last_sent_at, l.last_inbound_at) asc
  limit p_limit;
$$;
