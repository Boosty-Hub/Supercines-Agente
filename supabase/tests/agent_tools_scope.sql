-- Prueba de la migración 0078: LEER y escribir agent_tools (URLs y headers con placeholders de
-- secretos) exige alcance configuracion también en la RLS; sin rol = sin acceso.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/agent_tools_scope.sql   (ver supabase/tests/README.md)
begin;

create temp table res (k text, v boolean);
grant all on res to public;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- Intenta insertar una tool como `authenticated` con el JWT dado; devuelve true si la RLS lo permitió.
create or replace function pg_temp.try_insert(p_claims text, p_name text) returns boolean language plpgsql as $$
declare v_ok boolean := true;
begin
  perform set_config('request.jwt.claims', p_claims, true);
  set local role authenticated;
  begin
    insert into agent_tools (name, description, http_method, url_template)
    values (p_name, 'd', 'GET', 'https://a.example/x');
  exception when insufficient_privilege or others then
    v_ok := false;
  end;
  reset role;
  return v_ok;
end $$;

delete from agent_tools where name like 'zz_scope_%';

insert into res values
  ('contenido',     pg_temp.try_insert('{"role":"authenticated","app_metadata":{"role":"contenido"}}', 'zz_scope_a')),
  ('operacion',     pg_temp.try_insert('{"role":"authenticated","app_metadata":{"role":"operacion"}}', 'zz_scope_b')),
  ('editor',        pg_temp.try_insert('{"role":"authenticated","app_metadata":{"role":"editor"}}', 'zz_scope_c')),
  ('corrupto',      pg_temp.try_insert('{"role":"authenticated","app_metadata":{"role":"Admin "}}', 'zz_scope_d')),
  ('configuracion', pg_temp.try_insert('{"role":"authenticated","app_metadata":{"role":"configuracion"}}', 'zz_scope_e')),
  ('admin',         pg_temp.try_insert('{"role":"authenticated","app_metadata":{"role":"admin"}}', 'zz_scope_f')),
  ('sin rol',       pg_temp.try_insert('{"role":"authenticated","app_metadata":{}}', 'zz_scope_g')),
  ('sin app_meta',  pg_temp.try_insert('{"role":"authenticated"}', 'zz_scope_h'));

select pg_temp.expect('operacion NO puede crear una tool', (select not v from res where k = 'operacion'));
select pg_temp.expect('contenido NO puede crear una tool', (select not v from res where k = 'contenido'));
select pg_temp.expect('editor (alias de contenido) NO puede', (select not v from res where k = 'editor'));
select pg_temp.expect('un rol irreconocible cae CERRADO', (select not v from res where k = 'corrupto'));
select pg_temp.expect('configuracion SÍ puede', (select v from res where k = 'configuracion'));
select pg_temp.expect('admin (alias) SÍ puede', (select v from res where k = 'admin'));
select pg_temp.expect('sin rol / sin app_metadata NO puede (fail-closed; 0078 le fijó configuracion a los existentes)',
  (select not bool_or(v) from res where k in ('sin rol', 'sin app_meta')));

-- update y delete también exigen el alcance
create or replace function pg_temp.try_update(p_claims text) returns int language plpgsql as $$
declare v_n int := 0;
begin
  perform set_config('request.jwt.claims', p_claims, true);
  set local role authenticated;
  begin
    update agent_tools set url_template = 'https://evil.example/x' where name = 'zz_scope_e';
    get diagnostics v_n = row_count;
  exception when others then v_n := -1;
  end;
  reset role;
  return v_n;
end $$;
create or replace function pg_temp.try_delete(p_claims text) returns int language plpgsql as $$
declare v_n int := 0;
begin
  perform set_config('request.jwt.claims', p_claims, true);
  set local role authenticated;
  begin
    delete from agent_tools where name = 'zz_scope_e';
    get diagnostics v_n = row_count;
  exception when others then v_n := -1;
  end;
  reset role;
  return v_n;
end $$;

select pg_temp.expect('contenido: UPDATE no toca ninguna fila',
  pg_temp.try_update('{"role":"authenticated","app_metadata":{"role":"contenido"}}') <= 0);
select pg_temp.expect('contenido: DELETE no borra nada',
  pg_temp.try_delete('{"role":"authenticated","app_metadata":{"role":"contenido"}}') <= 0);
select pg_temp.expect('la tool sigue intacta', (select url_template = 'https://a.example/x' from agent_tools where name = 'zz_scope_e'));
select pg_temp.expect('configuracion: UPDATE sí',
  pg_temp.try_update('{"role":"authenticated","app_metadata":{"role":"configuracion"}}') = 1);

-- lectura: solo configuracion (W3: URLs internas y qué secreto usa cada header)
create or replace function pg_temp.try_read(p_claims text) returns int language plpgsql as $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', p_claims, true);
  set local role authenticated;
  select count(*) into v_n from agent_tools;
  reset role;
  return v_n;
end $$;
select pg_temp.expect('operacion, contenido, editor, irreconocible y sin rol NO ven ninguna tool',
  pg_temp.try_read('{"role":"authenticated","app_metadata":{"role":"operacion"}}') = 0
  and pg_temp.try_read('{"role":"authenticated","app_metadata":{"role":"contenido"}}') = 0
  and pg_temp.try_read('{"role":"authenticated","app_metadata":{"role":"editor"}}') = 0
  and pg_temp.try_read('{"role":"authenticated","app_metadata":{"role":"Admin "}}') = 0
  and pg_temp.try_read('{"role":"authenticated","app_metadata":{}}') = 0
  and pg_temp.try_read('{"role":"authenticated"}') = 0);
select pg_temp.expect('configuracion y admin SÍ las leen',
  pg_temp.try_read('{"role":"authenticated","app_metadata":{"role":"configuracion"}}') >= 1
  and pg_temp.try_read('{"role":"authenticated","app_metadata":{"role":"admin"}}') >= 1);
select pg_temp.expect('authenticated sin truncate/references/trigger sobre agent_tools',
  not has_table_privilege('authenticated', 'agent_tools', 'truncate')
  and not has_table_privilege('authenticated', 'agent_tools', 'trigger'));

-- anon no puede ni leer ni escribir
select pg_temp.expect('anon sin permisos sobre agent_tools',
  not has_table_privilege('anon', 'agent_tools', 'select') and not has_table_privilege('anon', 'agent_tools', 'insert'));

rollback;
