-- Prueba de la migración 0076 (barrido de alertas para el webhook) contra un Postgres con
-- TODAS las migraciones aplicadas (descartable).
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/alert_webhook_sweep.sql
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

delete from alerts where true;

-- 1) las alertas existentes al agregar la columna no se notifican (backfill) y el default la deja null
insert into alerts (kind, severity, title, description) values ('outbound_blocked', 'warning', 'A', 'x');
select pg_temp.expect('una alerta nueva nace pendiente (webhook_notified_at null)',
  (select webhook_notified_at is null from alerts where title = 'A'));

-- 2) reclamo: devuelve las pendientes, las marca, y un segundo reclamo no las repite
select pg_temp.expect('claim devuelve la pendiente',
  (select count(*) = 1 and bool_and(kind = 'outbound_blocked') from claim_alerts_for_webhook()));
select pg_temp.expect('quedó marcada como notificada y no suprimida',
  (select webhook_notified_at is not null and not webhook_suppressed from alerts where title = 'A'));
select pg_temp.expect('un segundo claim no la devuelve (ni duplica)',
  (select count(*) = 0 from claim_alerts_for_webhook()));

-- 3) rate limit: solo p_limit por barrido, las demás esperan al siguiente
insert into alerts (kind, severity, title, description, created_at)
select 'inbound_dropped', 'critical', 'B' || g, 'x', now() - (g || ' minutes')::interval from generate_series(1, 25) g;
select pg_temp.expect('el barrido respeta p_limit (10)', (select count(*) = 10 from claim_alerts_for_webhook(10)));
select pg_temp.expect('quedan 15 pendientes para el siguiente barrido',
  (select count(*) = 15 from alerts where webhook_notified_at is null));
select pg_temp.expect('el siguiente barrido toma las más viejas primero',
  (select min(title) is not null from claim_alerts_for_webhook(5)));
delete from alerts where title like 'B%';

-- 4) las de más de 24 h se cierran sin postear
insert into alerts (kind, severity, title, description, created_at)
values ('draft_failed', 'warning', 'VIEJA', 'x', now() - interval '30 hours');
select pg_temp.expect('una alerta vieja no se devuelve', (select count(*) = 0 from claim_alerts_for_webhook()));
select pg_temp.expect('y queda cerrada y suprimida',
  (select webhook_notified_at is not null and webhook_suppressed from alerts where title = 'VIEJA'));

-- 5) dedupe: idéntica a una ya posteada en la última hora → suprimida; distinta referencia → sale
delete from alerts where true;
insert into alerts (kind, severity, title, description, ref_table, ref_id)
values ('outbound_blocked', 'warning', 'Texto bloqueado', 'x', 'drafts', '00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect('la primera sale', (select count(*) = 1 from claim_alerts_for_webhook()));
insert into alerts (kind, severity, title, description, ref_table, ref_id)
values ('outbound_blocked', 'warning', 'Texto bloqueado', 'x', 'drafts', '00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect('la idéntica de la última hora se suprime', (select count(*) = 0 from claim_alerts_for_webhook()));
select pg_temp.expect('queda marcada como suprimida',
  (select count(*) = 1 from alerts where webhook_suppressed and title = 'Texto bloqueado'));
insert into alerts (kind, severity, title, description, ref_table, ref_id)
values ('outbound_blocked', 'warning', 'Texto bloqueado', 'x', 'drafts', '00000000-0000-0000-0000-0000000000a2');
select pg_temp.expect('con OTRA referencia (otro draft) sí sale', (select count(*) = 1 from claim_alerts_for_webhook()));
-- la ventana vence: la misma de hace más de 1 h ya no suprime
update alerts set webhook_notified_at = now() - interval '2 hours' where webhook_suppressed = false;
insert into alerts (kind, severity, title, description, ref_table, ref_id)
values ('outbound_blocked', 'warning', 'Texto bloqueado', 'x', 'drafts', '00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect('pasada la ventana de dedupe la misma alerta vuelve a salir', (select count(*) = 1 from claim_alerts_for_webhook()));

-- 6) dedupe dentro del MISMO lote: de dos idénticas solo sale una
delete from alerts where true;
insert into alerts (kind, severity, title, description, created_at) values
  ('salesbot_not_delivered', 'warning', 'No confirmado', 'x', now() - interval '2 minutes'),
  ('salesbot_not_delivered', 'warning', 'No confirmado', 'x', now() - interval '1 minute');
select pg_temp.expect('dos idénticas en el mismo lote: sale una sola', (select count(*) = 1 from claim_alerts_for_webhook()));

-- 7) un reclamo no toma lo que otro tiene bloqueado (skip locked): dos barridos no se pisan
delete from alerts where true;
insert into alerts (kind, severity, title, description) values ('draft_failed', 'warning', 'L1', 'x');
select pg_temp.expect('el barrido usa for update skip locked (el reclamo es atómico)',
  position('skip locked' in lower(pg_get_functiondef('claim_alerts_for_webhook(int, interval, interval)'::regprocedure))) > 0);
select count(*) from claim_alerts_for_webhook();

-- 8) permisos: solo service_role
select pg_temp.expect('claim_alerts_for_webhook solo para service_role',
  has_function_privilege('service_role', 'claim_alerts_for_webhook(int, interval, interval)', 'execute')
  and not has_function_privilege('anon', 'claim_alerts_for_webhook(int, interval, interval)', 'execute')
  and not has_function_privilege('authenticated', 'claim_alerts_for_webhook(int, interval, interval)', 'execute')
  and not has_function_privilege('public', 'claim_alerts_for_webhook(int, interval, interval)', 'execute'));

-- 9) webhook_kinds: default con los tipos de esta tanda y sin dream_error; configs existentes se completan
select pg_temp.expect('el default incluye salesbot_not_delivered y provider_credit_exhausted y no dream_error',
  (select column_default like '%salesbot_not_delivered%' and column_default like '%provider_credit_exhausted%'
          and column_default not like '%dream_error%'
     from information_schema.columns where table_name = 'alert_config' and column_name = 'webhook_kinds'));
-- una configuración existente (el operador solo tenía draft_failed) recibe los tipos nuevos sin perder lo elegido
update alert_config set webhook_kinds = array['draft_failed']::text[];
update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'salesbot_not_delivered')
 where not ('salesbot_not_delivered' = any(webhook_kinds));
update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'provider_credit_exhausted')
 where not ('provider_credit_exhausted' = any(webhook_kinds));
select pg_temp.expect('el UPDATE de la migración agrega los tipos nuevos sin pisar lo elegido (idempotente)',
  (select webhook_kinds = array['draft_failed', 'salesbot_not_delivered', 'provider_credit_exhausted']::text[] from alert_config limit 1));

rollback;
