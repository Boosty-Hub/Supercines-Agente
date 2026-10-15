-- Prueba de C1/R1 (migración 0078, parte 1): SIN ROL = SIN ACCESO. El backfill promueve SOLO al
-- usuario MAESTRO (el creado primero: order by created_at, id) si no tiene rol; NINGÚN otro
-- usuario sin rol (p. ej. una cuenta de un registro público abierto) hereda `configuracion`;
-- un rol presente no se toca. Re-ejecuta el backfill dos veces (\ir): idempotente.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/scope_backfill.sql   (ver supabase/tests/README.md)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- El JWT que emitiría GoTrue para ese usuario: app_metadata = raw_app_meta_data.
create or replace function pg_temp.claims_de(p_id uuid) returns text language sql as $$
  select jsonb_build_object('role', 'authenticated', 'sub', id, 'app_metadata', coalesce(raw_app_meta_data, '{}'::jsonb))::text
    from auth.users where id = p_id
$$;

-- Corre p_sql como `authenticated` con los claims dados; filas leídas/afectadas o -1 si se rechazó.
create or replace function pg_temp.run_as(p_claims text, p_sql text) returns int language plpgsql as $$
declare v_n int := 0;
begin
  perform set_config('request.jwt.claims', p_claims, true);
  set local role authenticated;
  begin
    if p_sql ~* '^\s*select' then
      execute format('select count(*) from (%s) q', p_sql) into v_n;
    else
      execute p_sql;
      get diagnostics v_n = row_count;
    end if;
  exception when others then
    v_n := -1;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v_n;
end $$;

-- Usuarios con ids PROPIOS (únicos). created_at fija el orden: el maestro es el más viejo.
delete from auth.users where email like 'zz-%@test.local';
insert into auth.users (id, email, raw_app_meta_data, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'zz-master@test.local',  '{"provider":"email","providers":["email"]}', '1999-01-01'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'zz-otro@test.local',    '{"provider":"email","providers":["email"]}', '1999-02-01'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'zz-nullmeta@test.local', null,                                        '1999-03-01'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'zz-op@test.local',      '{"provider":"email","role":"operacion"}',    '1999-04-01'),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'zz-raro@test.local',    '{"provider":"email","role":"Admin "}',       '1999-05-01'),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'zz-vacio@test.local',   '{"provider":"email","role":""}',             '1999-06-01');

select pg_temp.expect('el maestro es el usuario más viejo',
  (select id = 'aaaaaaaa-0000-0000-0000-000000000001' from auth.users order by created_at, id limit 1));
select pg_temp.expect('antes del backfill, el maestro sin rol NO ve las tools ni los switches (fail-closed)',
  pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000001'), 'select * from agent_tools') = 0
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000001'), 'select * from kommo_publish_config') = 0);

-- Se aplica 0078 (dos veces: idempotente).
\ir ../migrations/0078_agent_tools_scope.sql
\ir ../migrations/0078_agent_tools_scope.sql

select pg_temp.expect('el MAESTRO sin rol queda en configuracion y conserva el resto de app_metadata',
  (select raw_app_meta_data = '{"provider":"email","providers":["email"],"role":"configuracion"}'::jsonb
     from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000001'));
select pg_temp.expect('NINGÚN otro usuario sin rol se promueve (ausente, app_metadata null o role vacío)',
  (select bool_and(raw_app_meta_data is null or raw_app_meta_data -> 'role' is null or raw_app_meta_data ->> 'role' = '')
     from auth.users where id in ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003',
                                  'aaaaaaaa-0000-0000-0000-000000000006')));
select pg_temp.expect('un rol presente NO se toca (operacion sigue operacion; uno irreconocible sigue cerrado)',
  (select raw_app_meta_data ->> 'role' = 'operacion' from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000004')
  and (select raw_app_meta_data ->> 'role' = 'Admin ' from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000005'));

insert into alerts (kind, title) values ('draft_failed', 'zz alerta backfill');
-- Con el JWT que emite GoTrue al refrescar, el maestro CONSERVA su acceso total.
select pg_temp.expect('el maestro accede a tools, switches, verticales y alertas',
  pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000001'), 'select * from agent_tools') >= 0
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000001'), 'select * from kommo_publish_config') >= 1
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000001'), 'select * from alerts') >= 1
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000001'),
        'insert into agent_tools (name, description, http_method, url_template) values (''zz_maestro'', ''d'', ''GET'', ''https://a.example/x'')') = 1);
select pg_temp.expect('el de operacion sigue sin ver las tools',
  pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000004'), 'select * from agent_tools') = 0);

-- Los OTROS sin rol (incluida una cuenta que pudo crear un registro público) no ven NADA ni escriben.
select pg_temp.expect('usuario sin rol (no maestro): no ve tools, switches, verticales, alertas, graders ni consumo',
  pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000002'), 'select * from agent_tools') = 0
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000002'), 'select * from kommo_publish_config') = 0
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000002'), 'select * from verticals') = 0
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000002'), 'select * from alerts') = 0
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000002'), 'select * from graders') = 0
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000002'), 'select * from usage_events') = 0);
select pg_temp.expect('usuario sin rol (no maestro): no escribe nada',
  pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000002'), 'update kommo_publish_config set agent_enabled = not agent_enabled') <= 0
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000002'),
        'insert into agent_tools (name, description, http_method, url_template) values (''zz_otro'', ''d'', ''GET'', ''https://a.example/x'')') = -1
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000002'), 'insert into graders (slug, name, prompt) values (''zz_n'', ''zz'', ''zz'')') = -1);

-- Un usuario creado DESPUÉS de 0078 sin rol (Admin API o SQL a mano): sin acceso a nada.
insert into auth.users (id, email, raw_app_meta_data, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000007', 'zz-nuevo@test.local', '{"provider":"email","providers":["email"]}', now());
select pg_temp.expect('usuario creado DESPUÉS sin rol: no ve ni escribe nada',
  pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000007'), 'select * from agent_tools') = 0
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000007'), 'select * from alerts') = 0
  and pg_temp.run_as(pg_temp.claims_de('aaaaaaaa-0000-0000-0000-000000000007'), 'update kommo_publish_config set agent_enabled = not agent_enabled') <= 0);

-- Re-aplicar la migración no promueve a nadie más (ya hay un maestro con rol)
\ir ../migrations/0078_agent_tools_scope.sql
select pg_temp.expect('re-aplicar 0078 no promueve a otros sin rol',
  (select count(*) = 0 from auth.users where email like 'zz-%@test.local' and raw_app_meta_data ->> 'role' = 'configuracion'
      and id <> 'aaaaaaaa-0000-0000-0000-000000000001'));

-- Si el maestro YA tiene un rol (aunque sea menor), el backfill no lo cambia ni promueve a otro.
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"contenido"}' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
\ir ../migrations/0078_agent_tools_scope.sql
select pg_temp.expect('un maestro con rol (contenido) se respeta; nadie más se promueve',
  (select raw_app_meta_data ->> 'role' = 'contenido' from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000001')
  and (select count(*) = 0 from auth.users where email like 'zz-%@test.local' and raw_app_meta_data ->> 'role' = 'configuracion'));

-- Maestro con role "" (vacío) cuenta como sin rol y se promueve.
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":""}' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
\ir ../migrations/0078_agent_tools_scope.sql
select pg_temp.expect('un maestro con role vacío recibe configuracion',
  (select raw_app_meta_data ->> 'role' = 'configuracion' from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000001'));

rollback;
