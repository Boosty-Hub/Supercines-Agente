-- Prueba de system_incidents (0071) contra un Postgres con TODAS las migraciones.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/system_incidents.sql
begin;
create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

delete from system_incidents where true;
insert into system_incidents (kind, title) values ('kommo_webhook_caido', 'a');
select pg_temp.expect('como mucho UN incidente abierto por kind',
  (select count(*) from (select 1 from system_incidents where kind = 'kommo_webhook_caido' and resolved_at is null) x) = 1);

do $$
begin
  begin
    insert into system_incidents (kind, title) values ('kommo_webhook_caido', 'dup');
    raise exception 'FALLO: permitió dos abiertos del mismo kind';
  exception when unique_violation then
    raise notice 'ok: el segundo abierto del mismo kind se rechaza';
  end;
end $$;

update system_incidents set resolved_at = now() where kind = 'kommo_webhook_caido';
insert into system_incidents (kind, title) values ('kommo_webhook_caido', 'reabierto');
select pg_temp.expect('resuelto el anterior, el kind se puede reabrir (historial conservado)',
  (select count(*) = 2 from system_incidents where kind = 'kommo_webhook_caido'));
select pg_temp.expect('anon no lee incidentes', not has_table_privilege('anon', 'system_incidents', 'SELECT'));
select pg_temp.expect('trigger_health_scan existe, es SECURITY DEFINER y no es ejecutable por anon/authenticated',
  exists (select 1 from pg_proc where proname = 'trigger_health_scan' and prosecdef)
  and not has_function_privilege('anon', 'trigger_health_scan()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'trigger_health_scan()', 'EXECUTE'));
select pg_temp.expect('el cron del health-scan está agendado',
  exists (select 1 from cron.job where jobname = 'health-scan-sweep'));
select pg_temp.expect('los kinds de salud salen al webhook de alertas por defecto',
  (select column_default like '%kommo_token%' and column_default like '%cola_atascada%' from information_schema.columns
    where table_name = 'alert_config' and column_name = 'webhook_kinds'));
rollback;
