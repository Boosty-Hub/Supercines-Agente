-- Prueba de 0083: marcador persistente «provisionada» (_app_secrets.PROVISIONED_AT).
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/provisioned_marker.sql   (ver supabase/tests/README.md)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

delete from _app_secrets where clave = 'PROVISIONED_AT';
delete from auth.users;

-- Despliegue recién creado, sin usuarios: la migración NO marca (el register lo hará).
\ir ../migrations/0083_provisioned_marker.sql
select pg_temp.expect('sin usuarios, 0083 no marca la instalación como provisionada',
  not exists (select 1 from _app_secrets where clave = 'PROVISIONED_AT'));

-- Instalación existente: hay un usuario → queda marcada (dos veces: idempotente).
insert into auth.users (id, email, raw_app_meta_data) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'zz-prov@test.local', '{"role":"configuracion"}');
\ir ../migrations/0083_provisioned_marker.sql
\ir ../migrations/0083_provisioned_marker.sql
select pg_temp.expect('con usuarios, 0083 marca la instalación (una sola fila)',
  (select count(*) = 1 from _app_secrets where clave = 'PROVISIONED_AT'));

-- Borrar TODOS los usuarios NO desmarca: la instalación sigue provisionada (recuperación manual).
delete from auth.users;
select pg_temp.expect('con 0 usuarios el marcador persiste (el primer arranque no se reabre)',
  exists (select 1 from _app_secrets where clave = 'PROVISIONED_AT') and not exists (select 1 from auth.users));

-- El reclamo del register es atómico: la clave es única, un segundo reclamo falla con 23505.
select pg_temp.expect('un segundo reclamo del marcador viola la clave única (carrera del primer register)',
  (select case when (select count(*) from (
       select 1 from _app_secrets where clave = 'PROVISIONED_AT') q) = 1 then true else false end));
do $$
begin
  begin
    insert into _app_secrets (clave, valor) values ('PROVISIONED_AT', now()::text);
    raise exception 'FALLO: el segundo reclamo no debió insertarse';
  exception when unique_violation then
    raise notice 'ok: segundo reclamo rechazado por unique_violation (23505)';
  end;
end $$;

-- Solo el servidor ve el secreto.
select pg_temp.expect('authenticated y anon no tienen acceso a _app_secrets',
  not has_table_privilege('authenticated', '_app_secrets', 'select')
  and not has_table_privilege('anon', '_app_secrets', 'select')
  and not has_table_privilege('authenticated', '_app_secrets', 'insert'));

rollback;
