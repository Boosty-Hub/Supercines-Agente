-- Rendimiento de la RLS (migración 0084): ninguna policy de public lee el JWT FUERA de una subconsulta escalar.
--
-- `current_setting('request.jwt.claim…')`, `auth.uid()`, `auth.jwt()` y `auth.role()` escritos
-- inline en una policy se evalúan UNA VEZ POR FILA: sobre decenas de miles de leads/mensajes/drafts
-- el inbox (inbox_lead_summaries, reemplazada en 0085) tardaba ~4,8 s y las consultas del panel llegaban al
-- statement_timeout. Envueltos en `(select …)` Postgres los convierte en un InitPlan que se evalúa
-- UNA vez por consulta (~1,4 s, igual que el dueño). La regla de acceso no cambia.
--
-- El chequeo recorre el texto de pg_policies.qual / with_check: cada aparición de esas lecturas
-- debe estar dentro de un paréntesis que abre con SELECT (subconsulta). Se ignoran los literales.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/rls_initplan.sql   (ver supabase/tests/README.md)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- true si `expr` lee el JWT en algún punto que NO está dentro de una subconsulta `( SELECT …)`.
create or replace function pg_temp.jwt_fuera_de_subconsulta(expr text) returns boolean
language plpgsql immutable as $$
declare
  s text := lower(coalesce(expr, ''));
  n int := length(s);
  i int := 1;
  ch text;
  pila boolean[] := '{}';
  patrones text[] := array['current_setting(''request.jwt.claim', 'auth.uid(', 'auth.jwt(', 'auth.role('];
  pat text;
begin
  while i <= n loop
    ch := substr(s, i, 1);
    foreach pat in array patrones loop
      if substr(s, i, length(pat)) = pat and not (true = any (pila)) then
        return true;
      end if;
    end loop;
    if ch = '''' then
      -- literal: saltar hasta la comilla de cierre ('' = comilla escapada)
      i := i + 1;
      while i <= n loop
        if substr(s, i, 1) = '''' then
          if substr(s, i + 1, 1) = '''' then i := i + 2; continue; end if;
          exit;
        end if;
        i := i + 1;
      end loop;
    elsif ch = '(' then
      pila := pila || (ltrim(substr(s, i + 1, 12)) like 'select%');
    elsif ch = ')' then
      pila := pila[1:greatest(coalesce(array_length(pila, 1), 0) - 1, 0)];
    end if;
    i := i + 1;
  end loop;
  return false;
end $$;

-- ── El detector distingue las dos formas (si no, el chequeo de abajo no probaría nada) ─────
select pg_temp.expect('detector: claims inline → detectado',
  pg_temp.jwt_fuera_de_subconsulta($x$COALESCE((((NULLIF(current_setting('request.jwt.claims'::text, true), ''::text))::jsonb -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text]), false)$x$));
select pg_temp.expect('detector: auth.uid() inline → detectado',
  pg_temp.jwt_fuera_de_subconsulta('(user_id = auth.uid())'));
select pg_temp.expect('detector: auth.jwt() inline → detectado',
  pg_temp.jwt_fuera_de_subconsulta($x$((auth.jwt() ->> 'role'::text) = 'x'::text)$x$));
select pg_temp.expect('detector: claims en subconsulta escalar → aceptado',
  not pg_temp.jwt_fuera_de_subconsulta($x$COALESCE((( SELECT ((NULLIF(current_setting('request.jwt.claims'::text, true), ''::text))::jsonb -> 'app_metadata'::text) ->> 'role'::text)) = ANY (ARRAY['admin'::text]), false)$x$));
select pg_temp.expect('detector: (select auth.uid()) → aceptado',
  not pg_temp.jwt_fuera_de_subconsulta('(user_id = ( SELECT auth.uid() AS uid))'));
select pg_temp.expect('detector: subconsulta cerrada y lectura inline después → detectado',
  pg_temp.jwt_fuera_de_subconsulta('((( SELECT 1) = 1) AND (user_id = auth.uid()))'));
select pg_temp.expect('detector: el patrón dentro de un literal no cuenta',
  not pg_temp.jwt_fuera_de_subconsulta($x$(x = 'auth.uid()'::text)$x$));

-- ── Policy real creada inline: el chequeo la detecta (y la forma initplan pasa) ───────────
create table public.zz_rls_initplan (id int primary key, owner uuid);
create policy zz_inline on public.zz_rls_initplan for select to authenticated
  using (owner::text = nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub');
create policy zz_initplan on public.zz_rls_initplan for update to authenticated
  using (owner = (select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid)
  with check (owner = (select auth.uid()));
select pg_temp.expect('una policy con los claims inline es detectada en pg_policies',
  exists (select 1 from pg_policies where tablename = 'zz_rls_initplan' and policyname = 'zz_inline'
             and pg_temp.jwt_fuera_de_subconsulta(qual)));
select pg_temp.expect('una policy con (select …) pasa en qual y with_check',
  exists (select 1 from pg_policies where tablename = 'zz_rls_initplan' and policyname = 'zz_initplan'
             and not pg_temp.jwt_fuera_de_subconsulta(qual) and not pg_temp.jwt_fuera_de_subconsulta(with_check)));
drop table public.zz_rls_initplan;

-- ── El chequeo: ninguna policy de public lee el JWT por fila ───────────────────────────────
select pg_temp.expect('ninguna policy de public lee el JWT fuera de una subconsulta escalar; culpables: ' ||
    coalesce((select string_agg(tablename || '.' || policyname, ', ' order by tablename, policyname)
                from pg_policies
               where schemaname = 'public'
                 and (pg_temp.jwt_fuera_de_subconsulta(qual) or pg_temp.jwt_fuera_de_subconsulta(with_check))), '-'),
  not exists (select 1 from pg_policies
               where schemaname = 'public'
                 and (pg_temp.jwt_fuera_de_subconsulta(qual) or pg_temp.jwt_fuera_de_subconsulta(with_check))));

-- Y el chequeo no es vacuo: hay policies que leen el JWT (todas en la forma initplan).
select pg_temp.expect('hay policies de public que leen el JWT (el chequeo no es vacuo)',
  (select count(*) from pg_policies
    where schemaname = 'public' and lower(coalesce(qual, '') || coalesce(with_check, '')) like '%request.jwt.claim%') >= 20);

-- ── El plan: la lectura de los claims es un InitPlan, no un filtro por fila ───────────────
create temp table plan_leads (linea text);
grant insert on plan_leads to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","app_metadata":{"role":"operacion"}}', true);
do $$
declare r record;
begin
  for r in execute 'explain (costs off) select id from public.leads' loop
    insert into plan_leads values (r."QUERY PLAN");
  end loop;
end $$;
reset role;
select pg_temp.expect('explain de leads como authenticated: la policy usa un InitPlan',
  exists (select 1 from plan_leads where linea ilike '%InitPlan%'));
select pg_temp.expect('explain de leads como authenticated: current_setting no aparece en el filtro por fila',
  not exists (select 1 from plan_leads where linea ilike '%Filter:%current_setting%'));

rollback;
