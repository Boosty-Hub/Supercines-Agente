-- =============================================================
-- 0073_kommo_webhook_auth.sql
-- Autenticidad del webhook de Kommo + defensa del orden de eventos.
--
-- kommo-webhook es la única Edge Function pública y Kommo NO firma sus webhooks: sin
-- un secreto, cualquiera que conozca la URL puede postear un leads.update con
-- last_modified en el futuro y congelar a un lead en una etapa (las actualizaciones
-- reales se descartan como "viejas"; ver apply_lead_position). La mitigación que Kommo
-- permite es un secreto en la URL (?token=...).
--
--  · _app_secrets.KOMMO_WEBHOOK_SECRET: el secreto vigente (nunca expuesto a anon).
--    KOMMO_WEBHOOK_SECRET_PREVIOUS: el anterior, aceptado hasta previous_expires_at,
--    para rotar sin downtime (se cambia la URL en Kommo mientras ambos valen).
--  · kommo_webhook_auth (singleton): modo 'permissive' (acepta también requests sin
--    secreto, y deja una alerta) o 'strict' (descarta sin encolar; Kommo recibe 200 igual). Los clientes vivos arrancan
--    en permissive: hoy tienen el webhook SIN secreto en Kommo. Pasa a strict cuando el
--    operador lo confirma (switch del dashboard) o solo, cuando llegaron requests con
--    secreto y pasaron strict_after_hours sin requests sin secreto.
--  · (La segunda capa —recorte del instante a now() + 2 min— vive en apply_lead_position, 0065.)
-- IDEMPOTENTE.
-- =============================================================

insert into _app_secrets (clave, valor)
values ('KOMMO_WEBHOOK_SECRET', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (clave) do nothing;

create table if not exists kommo_webhook_auth (
  singleton           boolean primary key default true check (singleton),
  mode                text not null default 'permissive' check (mode in ('permissive', 'strict')),
  strict_after_hours  int  not null default 24 check (strict_after_hours between 1 and 720),
  last_signed_at      timestamptz,
  last_unsigned_at    timestamptz,
  strict_since        timestamptz,
  strict_reason       text,
  previous_expires_at timestamptz,
  updated_at          timestamptz not null default now()
);
insert into kommo_webhook_auth (singleton) values (true) on conflict do nothing;

-- Rotación segura (sin perder el secreto que Kommo usa de verdad) y auditoría de descartes.
--  · rotated_at: última rotación. current_confirmed_at: cuándo se confirmó que Kommo usa el
--    secreto VIGENTE (llegó una request firmada con él, o «Actualizar en Kommo» terminó
--    bien). Mientras el anterior siga vigente y el actual no esté confirmado, otra rotación
--    se rechaza: pisaría KOMMO_WEBHOOK_SECRET_PREVIOUS, que puede ser el único que Kommo tiene.
--  · last_rejected_at / last_rejected_reason: último descarte (token incorrecto o sin token
--    en estricto). El webhook responde 200 igual (invariante 6); la auditoría queda acá.
alter table kommo_webhook_auth add column if not exists rotated_at timestamptz;
alter table kommo_webhook_auth add column if not exists current_confirmed_at timestamptz;
alter table kommo_webhook_auth add column if not exists last_rejected_at timestamptz;
alter table kommo_webhook_auth add column if not exists last_rejected_reason text;

alter table kommo_webhook_auth enable row level security;
revoke all on kommo_webhook_auth from anon, authenticated, public;
-- El panel solo LEE el estado (el secreto no está en esta tabla); las escrituras van
-- por service_role desde las rutas del servidor.
grant select on kommo_webhook_auth to authenticated;
drop policy if exists authenticated_read on kommo_webhook_auth;
create policy authenticated_read on kommo_webhook_auth for select to authenticated using (true);

-- Registro de una request al webhook (lo llama kommo-webhook después de responder,
-- estrangulado a una vez por minuto, tipo e instancia). Devuelve el modo vigente.
--  · firmada con el VIGENTE (p_current) → confirma la última rotación;
--  · firmada → evalúa el paso automático a strict;
--  · sin secreto (aceptada en transición) → UNA alerta webhook_unsigned cada 6 h;
--  · descartada (p_rejected = motivo) → marca y UNA alerta webhook_rejected cada 6 h.
drop function if exists kommo_webhook_note(boolean);
create or replace function kommo_webhook_note(p_signed boolean, p_current boolean default false, p_rejected text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a kommo_webhook_auth%rowtype;
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  select * into a from kommo_webhook_auth where singleton for update;
  if not found then return 'permissive'; end if;

  if p_rejected is not null then
    update kommo_webhook_auth
       set last_rejected_at = now(), last_rejected_reason = left(p_rejected, 40), updated_at = now()
     where singleton;
    if not exists (select 1 from alerts where kind = 'webhook_rejected' and created_at > now() - interval '6 hours') then
      insert into alerts (kind, severity, title, description, ref_table, metadata)
      values (
        'webhook_rejected', 'warning',
        'Se descartaron requests al webhook de Kommo',
        'Llegaron requests al webhook con una clave incorrecta o sin clave en modo estricto, y se descartaron sin '
        || 'encolar. Si es Kommo, su URL está desactualizada: pulsá «Actualizar en Kommo» en Configuración → Kommo '
        || '(los mensajes descartados no se recuperan). Si no, alguien está probando la URL.',
        'kommo_webhook_auth',
        jsonb_build_object('mode', a.mode, 'motivo', left(p_rejected, 40))
      );
    end if;
    return a.mode;
  end if;

  if p_signed then
    update kommo_webhook_auth
       set last_signed_at = now(),
           current_confirmed_at = case when p_current then now() else current_confirmed_at end,
           updated_at = now()
     where singleton;
    if a.mode = 'permissive'
       and (a.last_unsigned_at is null or a.last_unsigned_at < now() - make_interval(hours => a.strict_after_hours)) then
      update kommo_webhook_auth
         set mode = 'strict', strict_since = now(), strict_reason = 'auto', updated_at = now()
       where singleton;
      return 'strict';
    end if;
  else
    update kommo_webhook_auth set last_unsigned_at = now(), updated_at = now() where singleton;
    if a.mode = 'permissive'
       and not exists (select 1 from alerts where kind = 'webhook_unsigned' and created_at > now() - interval '6 hours') then
      insert into alerts (kind, severity, title, description, ref_table, metadata)
      values (
        'webhook_unsigned', 'warning',
        'El webhook de Kommo llega sin secreto',
        'Kommo está llamando al webhook sin el ?token=. Mientras tanto se acepta (modo transición), pero cualquiera '
        || 'que conozca la URL podría falsificar eventos. Actualizá la URL en Kommo (Configuración → Kommo) y pasá a modo estricto.',
        'kommo_webhook_auth',
        jsonb_build_object('mode', a.mode)
      );
    end if;
  end if;
  return a.mode;
end;
$$;
revoke execute on function kommo_webhook_note(boolean, boolean, text) from public, anon, authenticated;
grant execute on function kommo_webhook_note(boolean, boolean, text) to service_role;

-- Rotación ATÓMICA (fila bloqueada): el vigente pasa a anterior (válido p_grace_hours) y
-- p_new queda vigente. Devuelve 'ok' o 'pending_confirmation' si el anterior sigue vigente
-- y Kommo todavía no confirmó el actual (rotar otra vez perdería el que Kommo usa).
create or replace function kommo_webhook_rotate(p_new text, p_grace_hours int default 24)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a kommo_webhook_auth%rowtype;
  v_current text;
  v_prev text;
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  if p_new is null or length(p_new) < 32 then
    raise exception 'el secreto nuevo debe tener al menos 32 caracteres' using errcode = '22023';
  end if;
  select * into a from kommo_webhook_auth where singleton for update;
  if not found then
    raise exception 'kommo_webhook_auth sin fila (migración 0070 incompleta)';
  end if;
  select valor into v_current from _app_secrets where clave = 'KOMMO_WEBHOOK_SECRET';
  select valor into v_prev from _app_secrets where clave = 'KOMMO_WEBHOOK_SECRET_PREVIOUS';

  if v_prev is not null and a.previous_expires_at > now()
     and (a.current_confirmed_at is null or a.current_confirmed_at < coalesce(a.rotated_at, '-infinity'::timestamptz)) then
    return 'pending_confirmation';
  end if;

  if v_current is not null then
    insert into _app_secrets (clave, valor) values ('KOMMO_WEBHOOK_SECRET_PREVIOUS', v_current)
    on conflict (clave) do update set valor = excluded.valor;
  end if;
  insert into _app_secrets (clave, valor) values ('KOMMO_WEBHOOK_SECRET', p_new)
  on conflict (clave) do update set valor = excluded.valor;
  update kommo_webhook_auth
     set previous_expires_at = case when v_current is not null
                                    then now() + make_interval(hours => greatest(1, least(p_grace_hours, 168)))
                                    else previous_expires_at end,
         rotated_at = now(),
         current_confirmed_at = null,
         updated_at = now()
   where singleton;
  return 'ok';
end;
$$;
revoke execute on function kommo_webhook_rotate(text, int) from public, anon, authenticated;
grant execute on function kommo_webhook_rotate(text, int) to service_role;

-- «Actualizar en Kommo» terminó bien con p_secret: confirma el vigente SOLO si p_secret
-- sigue siendo el vigente (una rotación concurrente no queda confirmada por error).
create or replace function kommo_webhook_mark_applied(p_secret text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ok boolean;
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  select exists (select 1 from _app_secrets where clave = 'KOMMO_WEBHOOK_SECRET' and valor = p_secret) into v_ok;
  if v_ok then
    update kommo_webhook_auth set current_confirmed_at = now(), updated_at = now() where singleton;
  end if;
  return v_ok;
end;
$$;
revoke execute on function kommo_webhook_mark_applied(text) from public, anon, authenticated;
grant execute on function kommo_webhook_mark_applied(text) to service_role;

-- system_incidents (legible por cualquier usuario con sesión) llegó a guardar el destino
-- completo del webhook, con el ?token=, en metadata.destination (health-scan). Se enmascara
-- lo ya guardado; health-detectores.ts ya no lo escribe.
update system_incidents
   set metadata = jsonb_set(
         metadata, '{destination}',
         to_jsonb(regexp_replace(metadata->>'destination', '(token|secret)=[^&#[:space:]"''<>]+', '\1=***', 'gi')))
 where metadata ? 'destination'
   and metadata->>'destination' ~* '(token|secret)=[^&#[:space:]"''<>*]';

-- Aviso por webhook (Slack/Discord) de los nuevos tipos de alerta, sin pisar lo elegido.
alter table alert_config
  alter column webhook_kinds
  set default array[
    'draft_failed', 'human_review_needed', 'outcomes_regression', 'inbound_silence', 'inbound_dropped',
    'kommo_webhook_disabled', 'kommo_webhook_caido', 'kommo_token', 'ingesta_detenida', 'cola_atascada',
    'budget_exceeded', 'outbound_blocked', 'webhook_unsigned', 'webhook_rejected'
  ]::text[];
update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'webhook_unsigned')
 where not ('webhook_unsigned' = any(webhook_kinds));
update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'webhook_rejected')
 where not ('webhook_rejected' = any(webhook_kinds));
