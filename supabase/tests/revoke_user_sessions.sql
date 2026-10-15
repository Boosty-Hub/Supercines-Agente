-- Prueba de la migración 0082: revoke_user_sessions(p_user_id) corta los refresh tokens y las
-- sesiones de UN usuario (lo llama /api/users al bajar el alcance o borrar), solo service_role.
-- La imagen de prueba (supabase/postgres) trae el esquema auth inicial: auth.refresh_tokens
-- (user_id varchar) pero NO auth.sessions (la crea una migración posterior de GoTrue). Se prueba
-- primero así y después con auth.sessions + refresh_tokens.session_id como en Supabase.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/revoke_user_sessions.sql   (ver supabase/tests/README.md)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- Llama la RPC con el rol dado (y claims opcionales); -1 si se rechazó por privilegios.
create or replace function pg_temp.revocar(p_user uuid, p_role text, p_claims text default '') returns int
language plpgsql as $$
declare v_n int;
begin
  perform set_config('request.jwt.claims', p_claims, true);
  execute format('set local role %I', p_role);
  begin
    select public.revoke_user_sessions(p_user) into v_n;
  exception when insufficient_privilege then
    v_n := -1;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v_n;
end $$;
grant execute on function pg_temp.revocar(uuid, text, text) to public;

insert into auth.users (id, email) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'zz-baja@test.local'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'zz-otro@test.local');

-- ── 1) Sin auth.sessions (imagen de prueba) ──────────────────────────────────────
-- (si la imagen ya la trajera, esta rama igual pasa: no hay sesiones del usuario todavía)
insert into auth.refresh_tokens (token, user_id, revoked, created_at) values
  ('zz-t1', 'bbbbbbbb-0000-0000-0000-000000000001', false, now()),
  ('zz-t2', 'bbbbbbbb-0000-0000-0000-000000000001', true,  now()),
  ('zz-t3', 'bbbbbbbb-0000-0000-0000-000000000002', false, now());
select pg_temp.expect('service_role: borra los 2 refresh tokens del usuario y devuelve 2',
  pg_temp.revocar('bbbbbbbb-0000-0000-0000-000000000001', 'service_role') = 2);
select pg_temp.expect('no quedan refresh tokens del usuario; los de otro usuario siguen',
  not exists (select 1 from auth.refresh_tokens where user_id = 'bbbbbbbb-0000-0000-0000-000000000001')
  and exists (select 1 from auth.refresh_tokens where token = 'zz-t3'));
select pg_temp.expect('idempotente: una segunda llamada devuelve 0',
  pg_temp.revocar('bbbbbbbb-0000-0000-0000-000000000001', 'service_role') = 0);

-- ── 2) Con auth.sessions como en Supabase (sessions.user_id uuid; tokens en cascada) ─
do $$
begin
  if to_regclass('auth.sessions') is null then
    create table auth.sessions (
      id uuid primary key,
      user_id uuid not null references auth.users (id) on delete cascade,
      created_at timestamptz default now()
    );
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'auth' and table_name = 'refresh_tokens' and column_name = 'session_id') then
    alter table auth.refresh_tokens add column session_id uuid references auth.sessions (id) on delete cascade;
  end if;
end $$;
insert into auth.sessions (id, user_id) values
  ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000002');
insert into auth.refresh_tokens (token, user_id, revoked, created_at, session_id) values
  ('zz-s1', 'bbbbbbbb-0000-0000-0000-000000000001', false, now(), 'cccccccc-0000-0000-0000-000000000001'),
  ('zz-s2', 'bbbbbbbb-0000-0000-0000-000000000001', false, now(), 'cccccccc-0000-0000-0000-000000000002'),
  ('zz-s3', 'bbbbbbbb-0000-0000-0000-000000000002', false, now(), 'cccccccc-0000-0000-0000-000000000003');

-- ── 3) El guard: una petición con JWT de usuario se rechaza aunque tenga EXECUTE ─
grant execute on function public.revoke_user_sessions(uuid) to authenticated;
select pg_temp.expect('authenticated con JWT (aun con EXECUTE re-otorgado) es rechazado por el guard',
  pg_temp.revocar('bbbbbbbb-0000-0000-0000-000000000001', 'authenticated',
    '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated","app_metadata":{"role":"configuracion"}}') = -1);
revoke execute on function public.revoke_user_sessions(uuid) from authenticated;
select pg_temp.expect('nada se borró en el intento rechazado',
  (select count(*) = 2 from auth.sessions where user_id = 'bbbbbbbb-0000-0000-0000-000000000001'));

-- ── 4) Con dueño postgres (como la crea el runner del panel en Supabase) ───────
grant select, delete on auth.sessions to postgres;
alter function public.revoke_user_sessions(uuid) owner to postgres;
select pg_temp.expect('service_role: borra 2 refresh tokens + 2 sesiones del usuario (devuelve 4)',
  pg_temp.revocar('bbbbbbbb-0000-0000-0000-000000000001', 'service_role') = 4);
select pg_temp.expect('el usuario se quedó sin sesiones ni tokens; el otro conserva los suyos',
  not exists (select 1 from auth.sessions where user_id = 'bbbbbbbb-0000-0000-0000-000000000001')
  and not exists (select 1 from auth.refresh_tokens where user_id = 'bbbbbbbb-0000-0000-0000-000000000001')
  and exists (select 1 from auth.sessions where id = 'cccccccc-0000-0000-0000-000000000003')
  and exists (select 1 from auth.refresh_tokens where token = 'zz-s3'));

-- ── 5) Permisos y forma ──────────────────────────────────────────────────────────
select pg_temp.expect('EXECUTE solo service_role (ni PUBLIC, ni anon, ni authenticated)',
  has_function_privilege('service_role', 'revoke_user_sessions(uuid)', 'execute')
  and not has_function_privilege('anon', 'revoke_user_sessions(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'revoke_user_sessions(uuid)', 'execute')
  and not has_function_privilege('public', 'revoke_user_sessions(uuid)', 'execute'));
select pg_temp.expect('anon no puede llamarla',
  pg_temp.revocar('bbbbbbbb-0000-0000-0000-000000000002', 'anon') = -1);
select pg_temp.expect('SECURITY DEFINER con search_path = public, pg_temp',
  (select prosecdef and proconfig @> array['search_path=public, pg_temp']
     from pg_proc where oid = 'public.revoke_user_sessions(uuid)'::regprocedure));
do $$
begin
  perform public.revoke_user_sessions(null);
  raise exception 'FALLO: null aceptado';
exception when invalid_parameter_value then
  raise notice 'ok: null rechazado con invalid_parameter_value';
end $$;

rollback;
