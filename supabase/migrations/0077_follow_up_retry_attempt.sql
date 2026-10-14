-- =============================================================
-- 0077 — El reintento manual de un seguimiento es POR INTENTO
-- =============================================================
-- PROBLEMA: el botón «Reintentar»/«Reenviar» de /seguimiento solo mandaba el lead. El
-- servidor recalculaba el paso (follow_up_step + 1) y reintentaba ESE paso, aunque la
-- fila sobre la que la persona hizo clic fuera vieja: un intento ya superado por otro
-- posterior, o de un paso que el lead ya pasó. Peor: la confirmación «sí, reenviala
-- aunque pudo haberle llegado» (p_confirm_resend) se aplicaba al ÚLTIMO intento del
-- paso, que podía ser otro distinto del que la persona revisó en Kommo.
--
-- SOLUCIÓN: claim_follow_up recibe el intento que la persona eligió (p_attempt_id) y,
-- con la fila del lead lockeada (la misma que serializa toda reserva nueva), exige que
-- sea el ÚLTIMO intento de ese (lead, paso). Si hubo uno posterior → 'superseded' (el
-- panel responde 409 y pide recargar). El paso pedido ya tenía que ser
-- follow_up_step + 1 ('step_changed' si no). La confirmación de reenvío queda atada a
-- un intento concreto: p_confirm_resend exige p_manual y p_attempt_id.
--
-- «Último intento» = el más nuevo por (sent_at, id), el mismo orden que usan
-- follow_up_block_reason y el panel. Los intentos de un lead se crean en serie (a lo
-- sumo una reserva viva por lead) y sent_at se fija al reservar y al cerrar, así que ese
-- orden es el orden real de los intentos.
--
-- IDEMPOTENTE: drop function if exists de la firma de 0072 + create or replace.
-- Re-aplicar 0072 después recrea la firma vieja, y re-aplicar esta migración la quita.
-- =============================================================

drop function if exists claim_follow_up(uuid, int, uuid, uuid, int, boolean, boolean);

create or replace function claim_follow_up(
  p_lead_id        uuid,
  p_step           int,
  p_template_id    uuid,
  p_owner          uuid,
  p_lease_seconds  int     default 600,
  p_manual         boolean default false,
  p_confirm_resend boolean default false,
  p_attempt_id     uuid    default null
)
returns table (follow_up_id uuid, reason text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_step    int;
  v_status  text;
  v_opt_out boolean;
  v_block   text;
  v_latest  uuid;
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
  -- Confirmar un reenvío es una decisión humana sobre UN intento concreto.
  if coalesce(p_confirm_resend, false) and (not coalesce(p_manual, false) or p_attempt_id is null) then
    raise exception 'claim_follow_up: p_confirm_resend exige p_manual y p_attempt_id (el intento que se confirmó)'
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

  -- Reintento sobre un intento concreto: tiene que ser el último de ese (lead, paso).
  -- El lock del lead serializa la creación de intentos, así que la comprobación y la
  -- reserva son atómicas.
  if p_attempt_id is not null then
    select f.id into v_latest
      from follow_ups f
     where f.lead_id = p_lead_id and f.step = p_step
     order by f.sent_at desc, f.id desc
     limit 1;
    if v_latest is distinct from p_attempt_id then
      return query select null::uuid, 'superseded'::text;
      return;
    end if;
  end if;

  v_block := follow_up_block_reason(p_lead_id, p_step, p_manual, p_confirm_resend);
  if v_block is not null then
    return query select null::uuid, v_block;
    return;
  end if;

  begin
    -- sent_at = el instante real de la reserva (no el inicio de la transacción): es el
    -- orden con el que se decide cuál es el último intento.
    insert into follow_ups (lead_id, template_id, step, status, variables, claim_owner, claimed_at, lease_until, sent_at)
    values (p_lead_id, p_template_id, p_step, 'claimed', '{}'::jsonb, p_owner, clock_timestamp(),
            clock_timestamp() + make_interval(secs => p_lease_seconds), clock_timestamp())
    returning id into v_id;
  exception when unique_violation then
    -- Defensa en profundidad: el lock del lead ya serializa; el índice es la garantía final.
    return query select null::uuid, 'in_flight'::text;
    return;
  end;

  return query select v_id, 'claimed'::text;
end;
$$;
revoke execute on function claim_follow_up(uuid, int, uuid, uuid, int, boolean, boolean, uuid) from public, anon, authenticated;
grant execute on function claim_follow_up(uuid, int, uuid, uuid, int, boolean, boolean, uuid) to service_role;
