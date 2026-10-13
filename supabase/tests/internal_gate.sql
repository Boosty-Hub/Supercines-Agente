-- Prueba del gate interno (0061 + 0062 + 0069) contra un Postgres con TODAS las
-- migraciones aplicadas.  psql -v ON_ERROR_STOP=1 -f supabase/tests/internal_gate.sql
begin;
create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

select pg_temp.expect('existe el secreto interno',
  (select count(*) = 1 and bool_and(length(valor) >= 32) from _app_secrets where clave = 'INTERNAL_FUNCTION_SECRET'));
select pg_temp.expect('anon/authenticated no leen _app_secrets',
  not has_table_privilege('anon', '_app_secrets', 'SELECT') and not has_table_privilege('authenticated', '_app_secrets', 'SELECT'));
select pg_temp.expect('internal_function_headers() trae el secreto y nadie de afuera la ejecuta',
  (internal_function_headers() ? 'x-internal-secret')
  and not has_function_privilege('anon', 'internal_function_headers()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'internal_function_headers()', 'EXECUTE'));

-- Todo trigger_* de cron: SECURITY DEFINER, search_path fijo y cerrado a anon/authenticated.
select pg_temp.expect('hay triggers de cron', (select count(*) >= 9 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'trigger\_%'));
select pg_temp.expect('todo trigger_* es SECURITY DEFINER con search_path fijo',
  (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'trigger\_%'));
select pg_temp.expect('todo trigger_* manda internal_function_headers()',
  (select bool_and(pg_get_functiondef(p.oid) like '%internal_function_headers()%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'trigger\_%'));
select pg_temp.expect('nadie fuera del cron ejecuta trigger_*',
  (select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'trigger\_%'));
-- anon (clave pública) no tiene privilegio sobre NINGUNA tabla de public (0072) y una
-- tabla nueva tampoco nace abierta.
select pg_temp.expect('anon no tiene privilegios sobre ninguna tabla de public',
  not exists (select 1 from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'));
create table public.zz_tabla_de_prueba (id int);
select pg_temp.expect('una tabla NUEVA no nace abierta a anon',
  not has_table_privilege('anon', 'public.zz_tabla_de_prueba', 'SELECT'));
rollback;
