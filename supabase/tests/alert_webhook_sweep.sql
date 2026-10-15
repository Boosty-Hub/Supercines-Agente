-- Prueba de la migración 0076 (barrido de alertas para el webhook) contra un Postgres con
-- TODAS las migraciones aplicadas (descartable). Correr DESDE EL ARCHIVO (usa \ir para
-- re-aplicar la migración real sobre configuraciones de prueba):
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/alert_webhook_sweep.sql
\set kinds 'array[''draft_failed'',''human_review_needed'',''inbound_dropped'',''outbound_blocked'',''salesbot_not_delivered'',''webhook_rejected'']::text[]'

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- =====================================================================================
-- S4) dos barridos se SERIALIZAN: con el advisory lock tomado por otro, el reclamo espera.
--     (transacción propia, antes de tocar `alerts`, para no cruzar locks de fila)
-- =====================================================================================
begin;
create extension if not exists dblink;
select pg_advisory_lock(hashtextextended('alerts:webhook_sweep', 73));
select dblink_connect('g7_sweep', 'dbname=' || current_database() || ' user=' || current_user);
select dblink_send_query('g7_sweep', $q$select count(*) from claim_alerts_for_webhook(array['draft_failed']::text[])$q$);
select pg_sleep(0.7);
select pg_temp.expect('con el lock del barrido tomado por otra sesión, un segundo reclamo ESPERA (no corre en paralelo)',
  dblink_is_busy('g7_sweep') = 1);
select pg_advisory_unlock(hashtextextended('alerts:webhook_sweep', 73));
select pg_temp.expect('al liberarse el lock, el segundo reclamo termina',
  (select count(*) = 1 from dblink_get_result('g7_sweep') as t(c bigint)));
select dblink_disconnect('g7_sweep');
rollback;

begin;

delete from alerts where true;

-- 1) una alerta nueva nace pendiente
insert into alerts (kind, severity, title, description) values ('outbound_blocked', 'warning', 'A', 'x');
select pg_temp.expect('una alerta nueva nace pendiente (notified/posted null)',
  (select webhook_notified_at is null and webhook_posted_at is null from alerts where title = 'A'));

-- 2) reclamo: devuelve la pendiente, la marca POSTEADA, y un segundo reclamo no la repite
select pg_temp.expect('claim devuelve la pendiente con repeated = 0',
  (select count(*) = 1 and bool_and(kind = 'outbound_blocked' and repeated = 0) from claim_alerts_for_webhook(:kinds)));
select pg_temp.expect('quedó notificada, posteada y no suprimida',
  (select webhook_notified_at is not null and webhook_posted_at is not null and not webhook_suppressed from alerts where title = 'A'));
select pg_temp.expect('un segundo claim no la devuelve (ni duplica)',
  (select count(*) = 0 from claim_alerts_for_webhook(:kinds)));

-- S4) el reclamo toma el advisory lock de clave FIJA (queda tomado hasta el fin de la transacción)
select pg_temp.expect('claim_alerts_for_webhook tomó pg_advisory_xact_lock(hashtextextended(''alerts:webhook_sweep'', 73))',
  exists (
    select 1 from pg_locks l, (select hashtextextended('alerts:webhook_sweep', 73) as k) key
     where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
       and l.classid::bigint = (key.k >> 32) & 4294967295
       and l.objid::bigint = key.k & 4294967295
       and l.objsubid = 1));

-- 3) rate limit: solo p_limit por barrido, las más viejas primero
insert into alerts (kind, severity, title, description, created_at)
select 'inbound_dropped', 'critical', 'B' || lpad(g::text, 2, '0'), 'x', now() - (g || ' minutes')::interval from generate_series(1, 25) g;
select pg_temp.expect('el barrido respeta p_limit (10) y toma las más viejas',
  (select count(*) = 10 and min(title) = 'B16' from claim_alerts_for_webhook(:kinds, '{}'::text[], 10, 100)));
select pg_temp.expect('quedan 15 pendientes para el siguiente barrido',
  (select count(*) = 15 from alerts where webhook_notified_at is null));
delete from alerts where title like 'B%';

-- 4) tipos no notificables (fuera de p_kinds, p. ej. dream_error) se cierran sin postear y no gastan el cupo
insert into alerts (kind, severity, title, description, created_at)
select 'dream_error', 'warning', 'D' || g, 'x', now() - interval '1 hour' from generate_series(1, 12) g;
insert into alerts (kind, severity, title, description) values ('draft_failed', 'critical', 'NOTIF', 'x');
select pg_temp.expect('con 12 dream_error más viejos, la notificable igual sale en el barrido de 10',
  (select count(*) = 1 and bool_and(title = 'NOTIF') from claim_alerts_for_webhook(:kinds, '{}'::text[], 10, 100)));
select pg_temp.expect('los dream_error quedaron cerrados, ni posteados ni suprimidos',
  (select bool_and(webhook_notified_at is not null and webhook_posted_at is null and not webhook_suppressed)
     from alerts where kind = 'dream_error'));

-- 5) las de más de 24 h se cierran sin postear
insert into alerts (kind, severity, title, description, created_at)
values ('draft_failed', 'warning', 'VIEJA', 'x', now() - interval '30 hours');
select pg_temp.expect('una alerta vieja no se devuelve', (select count(*) = 0 from claim_alerts_for_webhook(:kinds)));
select pg_temp.expect('y queda cerrada, suprimida y SIN marca de posteada',
  (select webhook_notified_at is not null and webhook_suppressed and webhook_posted_at is null from alerts where title = 'VIEJA'));

-- S5a) una nueva idéntica a una vieja NUNCA posteada (descartada por edad) sí sale
insert into alerts (kind, severity, title, description) values ('draft_failed', 'warning', 'VIEJA', 'x');
select pg_temp.expect('idéntica a una descartada por antigüedad (nunca posteada): SALE',
  (select count(*) = 1 from claim_alerts_for_webhook(:kinds)));

-- S5a) idéntica a una backfilleada (notificada por el backfill de 0076, sin webhook_posted_at): SALE
delete from alerts where true;
insert into alerts (kind, severity, title, description, ref_table, ref_id, webhook_notified_at)
values ('salesbot_not_delivered', 'warning', 'Backfill', 'x', 'drafts', '00000000-0000-0000-0000-0000000000b1', now() - interval '5 minutes');
insert into alerts (kind, severity, title, description, ref_table, ref_id)
values ('salesbot_not_delivered', 'warning', 'Backfill', 'x', 'drafts', '00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect('idéntica a una backfilleada (sin posted_at): SALE',
  (select count(*) = 1 from claim_alerts_for_webhook(:kinds)));

-- 6) dedupe: idéntica a una POSTEADA en la última hora → suprimida; distinta referencia → sale
delete from alerts where true;
insert into alerts (kind, severity, title, description, ref_table, ref_id)
values ('outbound_blocked', 'warning', 'Texto bloqueado', 'x', 'drafts', '00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect('la primera sale', (select count(*) = 1 from claim_alerts_for_webhook(:kinds)));
insert into alerts (kind, severity, title, description, ref_table, ref_id)
values ('outbound_blocked', 'warning', 'Texto bloqueado', 'x', 'drafts', '00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect('la idéntica de la última hora se suprime', (select count(*) = 0 from claim_alerts_for_webhook(:kinds)));
select pg_temp.expect('queda marcada como suprimida y no posteada',
  (select count(*) = 1 from alerts where webhook_suppressed and webhook_posted_at is null and title = 'Texto bloqueado'));
insert into alerts (kind, severity, title, description, ref_table, ref_id)
values ('outbound_blocked', 'warning', 'Texto bloqueado', 'x', 'drafts', '00000000-0000-0000-0000-0000000000a2');
select pg_temp.expect('con OTRA referencia (otro draft) sí sale', (select count(*) = 1 from claim_alerts_for_webhook(:kinds)));

-- S5a) un POST fallido (alerts-scan vuelve webhook_posted_at a null) no suprime a la próxima idéntica
update alerts set webhook_posted_at = null where ref_id = '00000000-0000-0000-0000-0000000000a2';
insert into alerts (kind, severity, title, description, ref_table, ref_id)
values ('outbound_blocked', 'warning', 'Texto bloqueado', 'x', 'drafts', '00000000-0000-0000-0000-0000000000a2');
select pg_temp.expect('idéntica a una cuyo POST falló: SALE (el aviso nunca llegó)',
  (select count(*) = 1 from claim_alerts_for_webhook(:kinds)));

-- la ventana vence: la misma posteada hace más de 1 h ya no suprime
update alerts set webhook_posted_at = now() - interval '2 hours' where webhook_posted_at is not null;
insert into alerts (kind, severity, title, description, ref_table, ref_id)
values ('outbound_blocked', 'warning', 'Texto bloqueado', 'x', 'drafts', '00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect('pasada la ventana de dedupe la misma alerta vuelve a salir',
  (select count(*) = 1 from claim_alerts_for_webhook(:kinds)));

-- 7) dedupe dentro del MISMO lote: de tres idénticas sale una, con «+2 repetidas»
delete from alerts where true;
insert into alerts (kind, severity, title, description, created_at) values
  ('salesbot_not_delivered', 'warning', 'No confirmado', 'x', now() - interval '3 minutes'),
  ('salesbot_not_delivered', 'warning', 'No confirmado', 'x', now() - interval '2 minutes'),
  ('salesbot_not_delivered', 'warning', 'No confirmado', 'x', now() - interval '1 minute'),
  ('draft_failed', 'critical', 'Otra', 'x', now() - interval '1 minute');
create temp table claimed on commit drop as select * from claim_alerts_for_webhook(:kinds);
select pg_temp.expect('tres idénticas en el mismo lote: sale UNA (la más vieja) con repeated = 2',
  (select count(*) = 1 and min(repeated) = 2
     and min(created_at) = (select min(created_at) from alerts where title = 'No confirmado')
     from claimed where title = 'No confirmado'));
select pg_temp.expect('la alerta distinta del lote sale con repeated = 0',
  (select count(*) = 1 and min(repeated) = 0 from claimed where title = 'Otra'));
select pg_temp.expect('las dos repetidas quedan suprimidas y no posteadas',
  (select count(*) = 2 from alerts where title = 'No confirmado' and webhook_suppressed and webhook_posted_at is null));

-- 7b) INUNDACIÓN desde un tercero sin autenticar: 1000 webhook_rejected + 1 crítica.
delete from alerts where true;
select count(insert_alert_aggregated('webhook_rejected', 'warning', 'Se descartaron requests', 'x', 'kommo_webhook_auth',
                                     jsonb_build_object('motivo', 'g' || g), interval '1 hour'))
  from generate_series(1, 1000) g;
insert into alerts (kind, severity, title, description, created_at)
values ('kommo_webhook_disabled', 'critical', 'Kommo deshabilitó el webhook', 'x', now());
select pg_temp.expect('1000 eventos del mismo tipo en la ventana = UNA fila (la tabla no crece con la inundación)',
  (select count(*) = 1 from alerts where kind = 'webhook_rejected'));
select pg_temp.expect('la fila agregada lleva el contador (1000) y el último detalle',
  (select agg_count = 1000 and (metadata->>'count')::int = 1000 and metadata->>'motivo' = 'g1000'
     from alerts where kind = 'webhook_rejected'));
select pg_temp.expect('la tabla tiene como mucho N = 2 filas tras la inundación + la crítica',
  (select count(*) = 2 from alerts));
create temp table flood1 on commit drop as
  select * from claim_alerts_for_webhook(array['webhook_rejected', 'kommo_webhook_disabled']::text[],
                                         array['kommo_webhook_disabled']::text[], 10, 3);
select pg_temp.expect('la crítica sale en el PRIMER barrido', (select count(*) = 1 from flood1 where kind = 'kommo_webhook_disabled'));
select pg_temp.expect('y la agregada sale UNA sola vez (un solo aviso por ventana)', (select count(*) = 1 from flood1 where kind = 'webhook_rejected'));
-- los eventos siguientes de la misma ventana solo suben el contador: no hay otro aviso ni otra fila
select insert_alert_aggregated('webhook_rejected', 'warning', 'Se descartaron requests', 'x', 'kommo_webhook_auth', '{}'::jsonb, interval '1 hour');
select pg_temp.expect('un evento más en la misma ventana no crea fila ni reenvía el aviso',
  (select count(*) = 1 from alerts where kind = 'webhook_rejected')
  and (select count(*) = 0 from claim_alerts_for_webhook(array['webhook_rejected']::text[], '{}'::text[])));
select pg_temp.expect('insert_alert_aggregated solo para service_role',
  has_function_privilege('service_role', 'insert_alert_aggregated(text, text, text, text, text, jsonb, interval)', 'execute')
  and not has_function_privilege('anon', 'insert_alert_aggregated(text, text, text, text, text, jsonb, interval)', 'execute')
  and not has_function_privilege('authenticated', 'insert_alert_aggregated(text, text, text, text, text, jsonb, interval)', 'execute'));

-- 7c) aunque ALGUIEN inserte 1000 filas sueltas del mismo tipo (sin agregar), el cupo no se copa:
--     las críticas van primero y un tipo no crítico tiene tope por barrido.
delete from alerts where true;
insert into alerts (kind, severity, title, description, created_at)
select 'webhook_rejected', 'warning', 'R' || g, 'x', now() - interval '2 hours' + (g || ' seconds')::interval
  from generate_series(1, 1000) g;
insert into alerts (kind, severity, title, description, created_at) values
  ('provider_credit_exhausted', 'critical', 'Sin crédito', 'x', now()),
  ('budget_exceeded', 'critical', 'Presupuesto', 'x', now()),
  ('salesbot_not_delivered', 'critical', 'No confirmado', 'x', now());
create temp table flood2 on commit drop as
  select * from claim_alerts_for_webhook(
    array['webhook_rejected', 'provider_credit_exhausted', 'budget_exceeded', 'salesbot_not_delivered']::text[],
    array['provider_credit_exhausted', 'budget_exceeded', 'salesbot_not_delivered']::text[], 10, 3);
select pg_temp.expect('con 1000 filas sueltas más viejas, las 3 críticas salen en el primer barrido',
  (select count(*) = 3 from flood2 where kind in ('provider_credit_exhausted', 'budget_exceeded', 'salesbot_not_delivered')));
select pg_temp.expect('y el tipo inundado no pasa de su tope por barrido (3)', (select count(*) = 3 from flood2 where kind = 'webhook_rejected'));
select pg_temp.expect('el barrido nunca supera el cupo total (10)', (select count(*) <= 10 from flood2));
select pg_temp.expect('el resto de la inundación sigue pendiente (no se pierde ni se postea de golpe)',
  (select count(*) = 997 from alerts where kind = 'webhook_rejected' and webhook_notified_at is null));

-- 8) skip locked además del lock (no espera filas tomadas por otro escritor)
select pg_temp.expect('el reclamo usa for update skip locked',
  position('skip locked' in lower(pg_get_functiondef('claim_alerts_for_webhook(text[], text[], int, int, interval, interval)'::regprocedure))) > 0);

-- 9) permisos: solo service_role
select pg_temp.expect('claim_alerts_for_webhook solo para service_role',
  has_function_privilege('service_role', 'claim_alerts_for_webhook(text[], text[], int, int, interval, interval)', 'execute')
  and not has_function_privilege('anon', 'claim_alerts_for_webhook(text[], text[], int, int, interval, interval)', 'execute')
  and not has_function_privilege('authenticated', 'claim_alerts_for_webhook(text[], text[], int, int, interval, interval)', 'execute')
  and not has_function_privilege('public', 'claim_alerts_for_webhook(text[], text[], int, int, interval, interval)', 'execute'));
select pg_temp.expect('no queda la firma vieja (int, interval, interval)',
  to_regprocedure('claim_alerts_for_webhook(int, interval, interval)') is null);

-- 10) webhook_kinds: default sin dream_error; configs EXISTENTES reciben solo los tipos nuevos
select pg_temp.expect('el default incluye los tipos nuevos y no dream_error',
  (select column_default like '%salesbot_not_delivered%' and column_default like '%provider_credit_exhausted%'
          and column_default like '%webhook_rejected%' and column_default not like '%dream_error%'
     from information_schema.columns where table_name = 'alert_config' and column_name = 'webhook_kinds'));
-- (a) la config activa: el operador había dejado solo draft_failed (quitó los demás de producción)
update alert_config set webhook_kinds = array['draft_failed']::text[] where is_active;
-- (b) una config con exactamente el default de la versión de producción anterior (2f2ce14)
insert into alert_config (webhook_enabled, is_active, webhook_kinds) values (false, false, array[
  'draft_failed', 'human_review_needed', 'outcomes_regression', 'inbound_silence', 'inbound_dropped',
  'kommo_webhook_disabled', 'kommo_webhook_caido', 'kommo_token', 'ingesta_detenida', 'cola_atascada', 'budget_exceeded']::text[]);
-- se re-aplica la migración REAL (dos veces: idempotente)
\ir ../migrations/0076_alert_webhook_delivery.sql
\ir ../migrations/0076_alert_webhook_delivery.sql
select pg_temp.expect('la selección previa del operador se conserva y recibe SOLO los 6 tipos nuevos',
  (select webhook_kinds = array['draft_failed', 'outbound_blocked', 'webhook_unsigned', 'webhook_rejected',
                                'salesbot_not_delivered', 'provider_credit_exhausted', 'registro_abierto']::text[]
     from alert_config where is_active));
select pg_temp.expect('una config con el default de producción queda igual al default nuevo (mismo conjunto)',
  (select (select array_agg(x order by x) from unnest(webhook_kinds) x)
        = (select array_agg(x order by x) from unnest(array[
            'draft_failed', 'human_review_needed', 'outcomes_regression', 'inbound_silence', 'inbound_dropped',
            'kommo_webhook_disabled', 'budget_exceeded', 'outbound_blocked', 'salesbot_not_delivered',
            'provider_credit_exhausted', 'webhook_unsigned', 'webhook_rejected', 'kommo_webhook_caido',
            'kommo_token', 'ingesta_detenida', 'cola_atascada', 'registro_abierto']::text[]) x)
     from alert_config where not is_active));
select pg_temp.expect('re-aplicar la migración no toca las alertas ya reclamadas (backfill único)',
  (select count(*) = 1 from alerts where title = 'No confirmado' and webhook_posted_at is not null));

rollback;
