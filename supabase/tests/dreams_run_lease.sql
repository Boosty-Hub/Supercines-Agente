-- Prueba de la migración 0098: lease atómico de la fase de análisis de dreams-run (el cron
-- daily y el weekly coinciden el domingo 03:00; el botón «Correr ahora» puede pisarse con el
-- cron). Una sola corrida analiza a la vez; el lease vence solo; solo el dueño lo suelta.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/dreams_run_lease.sql   (ver supabase/tests/README.md)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

update dreams_run_lease set owner = null, leased_until = null, period = null;

create temp table t1 as select claim_dreams_run('daily', 600) as tok;
create temp table t2 as select claim_dreams_run('weekly', 600) as tok;
select pg_temp.expect('la primera corrida toma el lease',
  (select tok is not null from t1));
select pg_temp.expect('la segunda (weekly a la misma hora) recibe null: no analiza en paralelo',
  (select tok is null from t2));
select pg_temp.expect('el lease registra el período y vence en el futuro',
  (select period = 'daily' and leased_until > now() from dreams_run_lease));

select pg_temp.expect('un token ajeno no suelta el lease', release_dreams_run(gen_random_uuid()) = false);
select pg_temp.expect('el lease sigue tomado', (select owner is not null from dreams_run_lease));
select pg_temp.expect('el dueño lo suelta', release_dreams_run((select tok from t1)) = true);
select pg_temp.expect('suelto: sin dueño ni vencimiento',
  (select owner is null and leased_until is null from dreams_run_lease));
select pg_temp.expect('suelto, otra corrida puede tomarlo',
  claim_dreams_run('weekly', 600) is not null);

-- lease vencido (worker muerto): se puede volver a tomar
update dreams_run_lease set leased_until = now() - interval '1 second';
select pg_temp.expect('un lease vencido se recupera', claim_dreams_run('daily', 600) is not null);

-- la duración se acota (60..1800 s)
update dreams_run_lease set owner = null, leased_until = null;
select claim_dreams_run('daily', 999999);
select pg_temp.expect('la duración del lease se acota a 30 min',
  (select leased_until <= now() + interval '1800 seconds' from dreams_run_lease));
select release_dreams_run(owner) from dreams_run_lease;
select pg_temp.expect('sin token no suelta nada', release_dreams_run(null) = false);

select pg_temp.expect('solo service_role ejecuta las funciones',
  not has_function_privilege('anon', 'claim_dreams_run(text,integer)', 'execute')
  and not has_function_privilege('authenticated', 'claim_dreams_run(text,integer)', 'execute')
  and not has_function_privilege('anon', 'release_dreams_run(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'release_dreams_run(uuid)', 'execute')
  and has_function_privilege('service_role', 'claim_dreams_run(text,integer)', 'execute')
  and has_function_privilege('service_role', 'release_dreams_run(uuid)', 'execute'));
select pg_temp.expect('la tabla no es visible para anon ni authenticated',
  not has_table_privilege('anon', 'dreams_run_lease', 'select')
  and not has_table_privilege('authenticated', 'dreams_run_lease', 'select'));

-- el guard interno rechaza una petición con JWT de usuario aunque alguien re-otorgue EXECUTE
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
begin
  perform claim_dreams_run('daily', 600);
  raise exception 'FALLO: el guard no rechazó la petición con JWT de usuario';
exception when insufficient_privilege then
  raise notice 'ok: el guard rechaza una petición con JWT de usuario';
end $$;
reset request.jwt.claims;

rollback;
