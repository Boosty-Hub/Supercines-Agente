-- =============================================================
-- 0075 — Reserva atómica por lead y paso del seguimiento (a lo sumo un envío)
-- =============================================================
-- PROBLEMA: follow_up_due_leads no reservaba nada. follow-up-scan corre cada 5 min,
-- pero un barrido con varios leads (una sesión del agente de ~60 s por lead) dura más
-- que el intervalo: dos barridos superpuestos —o el reintento manual del panel contra
-- el barrido— elegían el MISMO lead con el MISMO paso y le mandaban la plantilla dos
-- veces (WhatsApp duplicado al cliente). Además, si el worker moría después de
-- disparar el salesbot y antes de registrar el envío, el paso no avanzaba y el
-- siguiente barrido lo reenviaba.
--
-- SOLUCIÓN (mismo patrón que la reserva de drafts de 0071). La reserva ES la fila del
-- intento en `follow_ups` (el log de seguimientos, que ya existía):
--   claim_follow_up ──▶ fila `claimed` (dueño + lease) para (lead, paso)
--     · lockea la fila del lead y exige que el paso siga siendo follow_up_step + 1;
--     · índice único: a lo sumo UNA fila `claimed` por lead y a lo sumo UNA fila
--       `claimed`/`sent` por (lead, paso) → de dos reservas concurrentes gana una, y un
--       paso enviado no se registra (ni se reserva) dos veces.
--   claimed ──mark_follow_up_sending──▶ claimed + sending_at (write-ahead ANTES del
--     salesbot; solo el dueño con el lease vigente; sin la marca no sale nada)
--   claimed ──finish_follow_up (guarda de dueño)──▶ sent (y avanza el lead en la MISMA
--     transacción) | failed
--   claimed ──release_follow_up_claim──▶ (se borra) el agente decidió no enviar / el lead
--     ya no aplica: nada salió y no hay nada que registrar
--   claimed con lease VENCIDO (worker muerto) ──recover_dead_follow_up_claims──▶
--     · sin sending_at → `failed` + interrupted (nada salió; el barrido lo reintenta,
--       hasta follow_up_max_interrupted() interrupciones del mismo paso; después solo a mano)
--     · con sending_at → la plantilla PUDO haber salido → NUNCA se reenvía: un worker lo
--       retoma solo para RESOLVERLO (saliente nuevo en Kommo respecto de `baseline` →
--       `sent`; si no se confirma → `failed` con sending_at = «sin confirmar» + alerta).
--   Un paso cuyo último intento quedó «sin confirmar» no lo reintenta el barrido: solo una
--   persona desde el panel, confirmando el reenvío (p_confirm_resend).
--
-- El lease (10 min) supera el wall clock máximo de una Edge Function (400 s): cuando
-- vence, el worker está muerto con certeza.
--
-- IDEMPOTENTE: add column if not exists, drop/add constraint, create or replace.
-- =============================================================

alter table follow_ups add column if not exists claim_owner uuid;
alter table follow_ups add column if not exists claimed_at  timestamptz;
alter table follow_ups add column if not exists lease_until timestamptz;
alter table follow_ups add column if not exists sending_at  timestamptz;
alter table follow_ups add column if not exists baseline    text[];
alter table follow_ups add column if not exists interrupted boolean not null default false;

comment on column follow_ups.claim_owner is
  'Worker (uuid por invocación de follow-up-scan) que tiene reservado el paso mientras status = claimed.';
comment on column follow_ups.lease_until is
  'Vencimiento de la reserva. Vencido = el worker murió (el lease supera el wall clock de una Edge Function).';
comment on column follow_ups.sending_at is
  'Write-ahead: se fija ANTES del salesbot. Si está, la plantilla pudo haber salido y el paso NO se reenvía solo. En una fila failed significa «sin confirmar».';
comment on column follow_ups.baseline is
  'IDs de eventos outgoing_chat_message del lead antes de disparar el salesbot (para resolver un envío interrumpido).';
comment on column follow_ups.interrupted is
  'El worker murió con la reserva tomada y antes de marcar el envío (no salió nada).';

-- Envíos duplicados que ya ocurrieron antes de esta migración: el primero queda `sent`,
-- los demás pasan a `duplicate` (quedan en el log tal como ocurrieron) para poder crear
-- el índice único. En una base sin duplicados no toca nada (idempotente).
update follow_ups f
   set status = 'duplicate'
  from (
    select id, row_number() over (partition by lead_id, step order by sent_at, id) as n
      from follow_ups
     where status = 'sent'
  ) d
 where f.id = d.id
   and d.n > 1;

alter table follow_ups drop constraint if exists follow_ups_status_check;
alter table follow_ups add constraint follow_ups_status_check
  check (status in ('claimed', 'sent', 'failed', 'duplicate'));

-- Una fila `claimed` siempre tiene dueño y vencimiento (si no, nadie la recuperaría).
alter table follow_ups drop constraint if exists follow_ups_claimed_lease_check;
alter table follow_ups add constraint follow_ups_claimed_lease_check
  check (status <> 'claimed' or (claim_owner is not null and lease_until is not null));

-- A lo sumo una reserva viva por lead (un lead no recibe dos seguimientos a la vez).
create unique index if not exists follow_ups_one_claim_per_lead
  on follow_ups (lead_id) where status = 'claimed';
-- A lo sumo un intento vivo o enviado por (lead, paso): registro idempotente del envío.
create unique index if not exists follow_ups_one_send_per_step
  on follow_ups (lead_id, step) where status in ('claimed', 'sent');
create index if not exists follow_ups_claim_lease_idx
  on follow_ups (lease_until) where status = 'claimed';

-- El panel solo LEE el log (seguimiento/page.tsx). Escribirlo (p. ej. borrar una
-- reserva viva o insertar un `sent`) habilitaría un envío duplicado: el usuario
-- autenticado pasa a solo lectura. Las Edge Functions (service_role) no pasan por RLS.
drop policy if exists authenticated_all on follow_ups;
drop policy if exists authenticated_read on follow_ups;
create policy authenticated_read on follow_ups
  for select to authenticated using (true);

-- -------------------------------------------------------------
-- Tope de reservas muertas (antes de marcar el envío) por paso, tras el cual el
-- barrido automático deja de reintentarlo. Única fuente del valor.
-- -------------------------------------------------------------
create or replace function follow_up_max_interrupted()
returns int language sql immutable set search_path = public, pg_temp as $$ select 3 $$;
revoke execute on function follow_up_max_interrupted() from public, anon, authenticated;
grant execute on function follow_up_max_interrupted() to service_role;

-- -------------------------------------------------------------
-- follow_up_block_reason: por qué NO se puede reservar (lead, paso) ahora; null = libre.
-- La usan claim_follow_up (decisión atómica, con el lead lockeado) y
-- follow_up_due_leads (para que un lead bloqueado no ocupe un lugar del barrido).
--   in_flight        → ya hay una reserva viva de ese lead (cualquier paso)
--   already_sent     → ese paso ya se envió
--   unconfirmed      → el último intento de ese paso pudo haber salido y no se confirmó
--                      (solo se reenvía con p_confirm_resend: una persona lo decide)
--   interrupted_cap  → el paso murió follow_up_max_interrupted() veces antes de enviar
--                      (el barrido no lo reintenta; a mano sí: p_manual)
-- -------------------------------------------------------------
create or replace function follow_up_block_reason(
  p_lead_id        uuid,
  p_step           int,
  p_manual         boolean default false,
  p_confirm_resend boolean default false
)
returns text
language sql stable set search_path = public, pg_temp as $$
  select case
    when exists (select 1 from follow_ups f where f.lead_id = p_lead_id and f.status = 'claimed')
      then 'in_flight'
    when exists (select 1 from follow_ups f where f.lead_id = p_lead_id and f.step = p_step and f.status = 'sent')
      then 'already_sent'
    when not coalesce(p_confirm_resend, false) and coalesce((
        select f.status = 'failed' and f.sending_at is not null
          from follow_ups f
         where f.lead_id = p_lead_id and f.step = p_step and f.status in ('failed', 'sent')
         order by f.sent_at desc, f.id desc
         limit 1), false)
      then 'unconfirmed'
    when not coalesce(p_manual, false) and (
        select count(*) from follow_ups f
         where f.lead_id = p_lead_id and f.step = p_step and f.interrupted
      ) >= follow_up_max_interrupted()
      then 'interrupted_cap'
  end
$$;
revoke execute on function follow_up_block_reason(uuid, int, boolean, boolean) from public, anon, authenticated;
grant execute on function follow_up_block_reason(uuid, int, boolean, boolean) to service_role;

-- -------------------------------------------------------------
-- claim_follow_up: reserva (lead, paso) para p_owner. Devuelve UNA fila:
-- (follow_up_id, 'claimed') o (null, motivo). La fila del lead se lockea (for update):
-- dos reservas del mismo lead se serializan y la segunda ve la primera.
-- -------------------------------------------------------------
create or replace function claim_follow_up(
  p_lead_id        uuid,
  p_step           int,
  p_template_id    uuid,
  p_owner          uuid,
  p_lease_seconds  int     default 600,
  p_manual         boolean default false,
  p_confirm_resend boolean default false
)
returns table (follow_up_id uuid, reason text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_step    int;
  v_status  text;
  v_opt_out boolean;
  v_block   text;
  v_id      uuid;
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  if p_lead_id is null or p_owner is null or p_step is null or p_step < 1
     or p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'claim_follow_up: p_lead_id, p_owner, p_step >= 1 y p_lease_seconds > 0 son obligatorios'
      using errcode = 'invalid_parameter_value';
  end if;

  select l.follow_up_step, l.follow_up_status, coalesce(l.opted_out, false)
    into v_step, v_status, v_opt_out
    from leads l
   where l.id = p_lead_id
   for update;
  if not found then
    return query select null::uuid, 'lead_not_found'::text;
    return;
  end if;
  if v_opt_out then
    return query select null::uuid, 'opted_out'::text;
    return;
  end if;
  if v_status in ('responded', 'stopped', 'exhausted') then
    return query select null::uuid, 'terminal'::text;
    return;
  end if;
  -- El paso pedido tiene que ser el siguiente: si otro worker ya lo envió (y avanzó
  -- el lead), un barrido que lo había elegido antes recibe step_changed.
  if coalesce(v_step, 0) + 1 <> p_step then
    return query select null::uuid, 'step_changed'::text;
    return;
  end if;

  v_block := follow_up_block_reason(p_lead_id, p_step, p_manual, p_confirm_resend);
  if v_block is not null then
    return query select null::uuid, v_block;
    return;
  end if;

  begin
    insert into follow_ups (lead_id, template_id, step, status, variables, claim_owner, claimed_at, lease_until)
    values (p_lead_id, p_template_id, p_step, 'claimed', '{}'::jsonb, p_owner, clock_timestamp(),
            clock_timestamp() + make_interval(secs => p_lease_seconds))
    returning id into v_id;
  exception when unique_violation then
    -- Defensa en profundidad: el lock del lead ya serializa; el índice es la garantía final.
    return query select null::uuid, 'in_flight'::text;
    return;
  end;

  return query select v_id, 'claimed'::text;
end;
$$;
revoke execute on function claim_follow_up(uuid, int, uuid, uuid, int, boolean, boolean) from public, anon, authenticated;
grant execute on function claim_follow_up(uuid, int, uuid, uuid, int, boolean, boolean) to service_role;

-- -------------------------------------------------------------
-- mark_follow_up_sending: write-ahead ANTES del salesbot. Solo el dueño, con el lease
-- VIGENTE: si venció (y otro pudo haber recuperado la reserva) devuelve false y el
-- llamador NO envía nada. Guarda la foto de salientes y las variables que se escribieron.
-- -------------------------------------------------------------
create or replace function mark_follow_up_sending(
  p_id        uuid,
  p_owner     uuid,
  p_baseline  text[] default null,
  p_variables jsonb  default null
)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  update follow_ups
     set sending_at = coalesce(sending_at, clock_timestamp()),
         baseline   = p_baseline,
         variables  = coalesce(p_variables, variables)
   where id = p_id
     and status = 'claimed'
     and claim_owner = p_owner
     and lease_until > clock_timestamp();
  return found;
end;
$$;
revoke execute on function mark_follow_up_sending(uuid, uuid, text[], jsonb) from public, anon, authenticated;
grant execute on function mark_follow_up_sending(uuid, uuid, text[], jsonb) to service_role;

-- -------------------------------------------------------------
-- finish_follow_up: cierra la reserva de p_owner como `sent` o `failed`. Con `sent`
-- avanza el lead (paso, último envío, estado) en la MISMA transacción: no existe el
-- instante «enviado pero el paso sin avanzar» que dejaba reenviarlo. El estado
-- `responded`/`stopped` que llegó mientras se enviaba se respeta (no se reabre la
-- secuencia de un lead que contestó). Devuelve false si la reserva ya no era suya.
-- -------------------------------------------------------------
create or replace function finish_follow_up(
  p_id             uuid,
  p_owner          uuid,
  p_status         text,
  p_error          text    default null,
  p_variables      jsonb   default null,
  p_max_follow_ups int     default null
)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead uuid;
  v_step int;
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  if p_status is null or p_status not in ('sent', 'failed') then
    raise exception 'finish_follow_up: p_status debe ser sent o failed' using errcode = 'invalid_parameter_value';
  end if;
  if p_status = 'sent' and (p_max_follow_ups is null or p_max_follow_ups < 1) then
    raise exception 'finish_follow_up: p_max_follow_ups es obligatorio al registrar un envío'
      using errcode = 'invalid_parameter_value';
  end if;

  update follow_ups
     set status      = p_status,
         error       = p_error,
         variables   = coalesce(p_variables, variables),
         sent_at     = clock_timestamp(),
         claim_owner = null,
         lease_until = null
   where id = p_id
     and status = 'claimed'
     and claim_owner = p_owner
  returning lead_id, step into v_lead, v_step;
  if not found then
    return false;
  end if;

  if p_status = 'sent' then
    update leads
       set follow_up_step         = v_step,
           follow_up_last_sent_at = clock_timestamp(),
           follow_up_status       = case
             when follow_up_status in ('responded', 'stopped') then follow_up_status
             when v_step >= p_max_follow_ups then 'exhausted'
             else 'active'
           end
     where id = v_lead
       and follow_up_step < v_step;
  end if;
  return true;
end;
$$;
revoke execute on function finish_follow_up(uuid, uuid, text, text, jsonb, int) from public, anon, authenticated;
grant execute on function finish_follow_up(uuid, uuid, text, text, jsonb, int) to service_role;

-- -------------------------------------------------------------
-- release_follow_up_claim: el dueño suelta la reserva sin haber enviado nada (el agente
-- decidió no escribir, el lead ya no aplica). Con la marca de envío NO se puede soltar:
-- se cierra con finish_follow_up (o la resuelve la recuperación).
-- -------------------------------------------------------------
create or replace function release_follow_up_claim(p_id uuid, p_owner uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  delete from follow_ups
   where id = p_id
     and status = 'claimed'
     and claim_owner = p_owner
     and sending_at is null;
  return found;
end;
$$;
revoke execute on function release_follow_up_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function release_follow_up_claim(uuid, uuid) to service_role;

-- -------------------------------------------------------------
-- recover_dead_follow_up_claims: barre las reservas `claimed` con lease vencido.
--   requeued → sin marca: `failed` + interrupted (nada salió); el barrido lo reintenta.
--   gave_up  → ídem, pero el paso ya llegó al tope de interrupciones: solo a mano.
--   resolve  → con marca: p_owner la retoma (lease nuevo) SOLO para resolverla
--              (saliente nuevo → sent; si no → failed sin confirmar + alerta). Nunca se reenvía.
-- -------------------------------------------------------------
create or replace function recover_dead_follow_up_claims(
  p_owner         uuid,
  p_lease_seconds int default 600,
  p_limit         int default 20
)
returns table (follow_up_id uuid, lead_id uuid, action text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  if p_owner is null or p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'recover_dead_follow_up_claims: p_owner y p_lease_seconds > 0 son obligatorios'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 1) Sin marca de envío → failed + interrupted (requeued / gave_up según el tope).
  return query
  with dead as (
    select f.id from follow_ups f
     where f.status = 'claimed'
       and f.lease_until < clock_timestamp()
       and f.sending_at is null
     order by f.lease_until
     limit p_limit
     for update skip locked
  ), prior as (
    select d.id,
           (select count(*) from follow_ups o
             where o.lead_id = f.lead_id and o.step = f.step and o.interrupted) + 1 as n
      from dead d join follow_ups f on f.id = d.id
  )
  update follow_ups f
     set status      = 'failed',
         interrupted = true,
         claim_owner = null,
         lease_until = null,
         sent_at     = clock_timestamp(),
         error       = case when prior.n >= follow_up_max_interrupted()
           then format('el seguimiento se interrumpió %s veces antes de enviar (no salió nada); el barrido no lo reintenta más: reintentalo a mano', prior.n)
           else 'el seguimiento se interrumpió antes de enviar (no salió nada); se reintenta en el próximo barrido'
         end
    from prior
   where f.id = prior.id
     and f.status = 'claimed'
     and f.sending_at is null
  returning f.id, f.lead_id,
            (case when prior.n >= follow_up_max_interrupted() then 'gave_up' else 'requeued' end)::text;

  -- 2) Con marca de envío → se retoma solo para resolver (NUNCA se reenvía).
  return query
  with dead as (
    select f.id from follow_ups f
     where f.status = 'claimed'
       and f.lease_until < clock_timestamp()
       and f.sending_at is not null
     order by f.lease_until
     limit p_limit
     for update skip locked
  )
  update follow_ups f
     set claim_owner = p_owner,
         lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
    from dead
   where f.id = dead.id
     and f.status = 'claimed'
     and f.sending_at is not null
  returning f.id, f.lead_id, 'resolve'::text;
end;
$$;
revoke execute on function recover_dead_follow_up_claims(uuid, int, int) from public, anon, authenticated;
grant execute on function recover_dead_follow_up_claims(uuid, int, int) to service_role;

-- -------------------------------------------------------------
-- follow_up_due_leads: misma lógica que 0059 + excluir los leads cuyo paso siguiente
-- está bloqueado (reserva viva, ya enviado, sin confirmar o en el tope de
-- interrupciones). Sin esto, un lead bloqueado ocuparía un lugar del p_limit de cada
-- barrido para nada (y varios así dejarían sin seguimiento al resto).
-- Misma firma y tipo de retorno → CREATE OR REPLACE (conserva los grants de 0059).
-- Mantener sincronizado con 0059 si cambia la lógica de etapas/horario/cooldown.
-- -------------------------------------------------------------
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
    l.follow_up_status is distinct from 'responded'
    and l.follow_up_status is distinct from 'exhausted'
    and l.follow_up_status is distinct from 'stopped'
    and coalesce(l.opted_out, false) = false
    and (
      cardinality(cfg.run_stage_ids) = 0
      or l.kommo_stage_id = any(cfg.run_stage_ids)
    )
    and l.follow_up_step < cfg.max_follow_ups
    and now() - coalesce(l.follow_up_last_sent_at, l.last_inbound_at)
          >= make_interval(hours => ns.delay_hours)
    and now() - coalesce(l.follow_up_last_sent_at, l.last_inbound_at)
          <  make_interval(hours => ns.delay_hours) + interval '72 hours'
    and (
      l.follow_up_last_sent_at is null
      or now() - l.follow_up_last_sent_at >= make_interval(hours => cfg.min_gap_hours)
    )
    and (
      l.follow_up_last_skipped_at is null
      or now() - l.follow_up_last_skipped_at >= interval '1 hour'
    )
    and l.last_inbound_at is not null
    -- 0075: el paso siguiente no está reservado, enviado, sin confirmar ni en el tope.
    and follow_up_block_reason(l.id, ns.step_number, false, false) is null
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

revoke execute on function follow_up_due_leads(int) from public, anon, authenticated;
grant execute on function follow_up_due_leads(int) to service_role;
