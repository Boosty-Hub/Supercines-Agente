-- Prueba de seguridad de EXECUTE sobre las funciones de `public` (migraciones 0063,
-- 0070 y 0072) contra un Postgres con TODAS las migraciones aplicadas:
--   1) `anon` no tiene EXECUTE en NINGUNA función propia de public. Funciones
--      públicas por diseño (hoy: ninguna): se agregan a PUBLICAS con su MOTIVO.
--   2) `authenticated` solo en la lista del panel (RPC llamadas con la sesión).
--   3) Las SECURITY DEFINER fijan search_path = public, pg_temp (cron puede sumar `cron`).
--   4) El guard interno de las SECURITY DEFINER rechaza a un usuario con JWT aunque
--      alguien le re-otorgue EXECUTE.
--   5) Una función NUEVA no nace abierta a anon/authenticated (default privileges).
--
--   sed 's#${SUPABASE_URL}#http://x.test#g' supabase/migrations/*.sql | psql ...   (una vez)
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/function_execute.sql
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- Funciones propias de public (sin las de extensiones: pgvector y pg_trgm viven en public).
create temp view propias as
  select p.oid, p.proname, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');

-- ── 1) anon ──────────────────────────────────────────────────────────────────
-- Funciones públicas por diseño → nombre => motivo. Hoy ninguna.
create temp table publicas (proname text primary key, motivo text not null);

select pg_temp.expect('hay funciones propias que revisar', (select count(*) >= 20 from propias));
select pg_temp.expect('anon NO tiene EXECUTE en ninguna función propia de public (salvo las documentadas)',
  not exists (
    select 1 from propias f
     where has_function_privilege('anon', f.oid, 'execute')
       and f.proname not in (select proname from publicas)));
select pg_temp.expect('PUBLIC tampoco (Postgres lo otorga por default)',
  not exists (select 1 from propias f where has_function_privilege('public', f.oid, 'execute')));

-- ── 2) authenticated: solo lo que el panel llama con la sesión del usuario ───
select pg_temp.expect('authenticated solo ejecuta inbox_lead_summaries y gasto_mes_actual',
  (select coalesce(array_agg(f.proname::text order by f.proname), '{}')
     from propias f where has_function_privilege('authenticated', f.oid, 'execute'))
  = array['gasto_mes_actual', 'inbox_lead_summaries']);
select pg_temp.expect('service_role ejecuta todas las propias',
  not exists (select 1 from propias f where not has_function_privilege('service_role', f.oid, 'execute')));

-- ── 3) SECURITY DEFINER: search_path fijo ────────────────────────────────────
select pg_temp.expect('toda SECURITY DEFINER fija search_path con pg_temp',
  not exists (
    select 1 from propias f
     where f.prosecdef
       and not exists (select 1 from unnest(coalesce(f.proconfig, '{}')) c where c like 'search_path=%pg_temp%')));

-- ── 4) El guard interno rechaza a un usuario con JWT aun con EXECUTE otorgado ─
grant execute on function public.hub_metrics() to authenticated;
grant execute on function public.claim_message_batch(uuid[], uuid) to authenticated;
grant execute on function public.purge_retention() to authenticated;
grant execute on function public.internal_function_headers() to authenticated;
grant execute on function public.trigger_dreams(text) to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

create or replace function pg_temp.rechaza(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when insufficient_privilege then
  return true;
end $$;
grant execute on function pg_temp.rechaza(text) to authenticated;
create temp table res (k text, ok boolean);
grant all on res to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
-- (bajo el rol authenticated no se puede llamar a pg_temp.expect: se guarda y se evalúa después)
insert into res values ('hub_metrics', pg_temp.rechaza('select public.hub_metrics()'));
insert into res values ('claim_message_batch', pg_temp.rechaza('select public.claim_message_batch(array[]::uuid[], gen_random_uuid())'));
insert into res values ('purge_retention', pg_temp.rechaza('select * from public.purge_retention()'));
insert into res values ('internal_function_headers', pg_temp.rechaza('select public.internal_function_headers()'));
insert into res values ('trigger_dreams', pg_temp.rechaza($q$select public.trigger_dreams('daily')$q$));
reset role;
reset request.jwt.claims;

select pg_temp.expect('el guard rechaza a un usuario con JWT en hub_metrics, claim_message_batch, purge_retention, trigger_dreams e internal_function_headers (no filtra el secreto)',
  (select count(*) = 5 and bool_and(ok) from res));

-- Y SIN claims (service_role / pg_cron / dueño) sí corren.
select pg_temp.expect('hub_metrics corre para el dueño/service (sin JWT)', public.hub_metrics() is not null);
select pg_temp.expect('internal_function_headers entrega el secreto al cron (sin JWT)',
  public.internal_function_headers() ? 'x-internal-secret');

-- ── 5) Una función nueva no nace abierta ─────────────────────────────────────
create function public.zz_funcion_de_prueba() returns int language sql as 'select 1';
select pg_temp.expect('función NUEVA: sin EXECUTE para anon, authenticated ni PUBLIC',
  not has_function_privilege('anon', 'public.zz_funcion_de_prueba()', 'execute')
  and not has_function_privilege('authenticated', 'public.zz_funcion_de_prueba()', 'execute')
  and not has_function_privilege('public', 'public.zz_funcion_de_prueba()', 'execute'));

rollback;
