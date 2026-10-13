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
--    secreto, y deja una alerta) o 'strict' (rechaza 401). Los clientes vivos arrancan
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

alter table kommo_webhook_auth enable row level security;
revoke all on kommo_webhook_auth from anon, authenticated, public;
-- El panel solo LEE el estado (el secreto no está en esta tabla); las escrituras van
-- por service_role desde las rutas del servidor.
grant select on kommo_webhook_auth to authenticated;
drop policy if exists authenticated_read on kommo_webhook_auth;
create policy authenticated_read on kommo_webhook_auth for select to authenticated using (true);

-- Registro de una request al webhook (lo llama kommo-webhook, estrangulado a una vez por
-- minuto por instancia). Devuelve el modo vigente. Con requests sin secreto deja UNA
-- alerta cada 6 h; con requests firmadas evalúa el paso automático a strict.
create or replace function kommo_webhook_note(p_signed boolean)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a kommo_webhook_auth%rowtype;
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  select * into a from kommo_webhook_auth where singleton for update;
  if not found then return 'permissive'; end if;

  if p_signed then
    update kommo_webhook_auth set last_signed_at = now(), updated_at = now() where singleton;
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
revoke execute on function kommo_webhook_note(boolean) from public, anon, authenticated;
grant execute on function kommo_webhook_note(boolean) to service_role;

-- Aviso por webhook (Slack/Discord) del nuevo tipo de alerta, sin pisar lo elegido.
alter table alert_config
  alter column webhook_kinds
  set default array[
    'draft_failed', 'human_review_needed', 'outcomes_regression', 'inbound_silence', 'inbound_dropped',
    'kommo_webhook_disabled', 'kommo_webhook_caido', 'kommo_token', 'ingesta_detenida', 'cola_atascada',
    'budget_exceeded', 'outbound_blocked', 'webhook_unsigned'
  ]::text[];
update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'webhook_unsigned')
 where not ('webhook_unsigned' = any(webhook_kinds));

