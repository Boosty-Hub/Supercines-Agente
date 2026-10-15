-- =============================================================
-- 0084_rls_claims_initplan.sql
-- La lectura de los claims del JWT en las policies pasa a una SUBCONSULTA ESCALAR (InitPlan).
--
-- PROBLEMA: las policies por alcance (agent_tools_scope / runtime_config_lockdown) leían los
-- claims INLINE: `(nullif(current_setting('request.jwt.claims', true), ''))::jsonb` y
-- `nullif(current_setting('request.jwt.claim.sub', true), '')`. Postgres evalúa esa expresión
-- (current_setting + parseo del JSON) UNA VEZ POR FILA: sobre decenas de miles de
-- leads/mensajes/drafts, las consultas del panel como `authenticated` (el RPC del inbox) tardaban
-- varios segundos y rozaban el statement_timeout de 8 s de la API.
--
-- FIX: cada lectura se envuelve en `(select …)`. Al no depender de la fila, Postgres la calcula
-- UNA vez por consulta (InitPlan) y la reutiliza. La regla de acceso es IDÉNTICA: se reescribe
-- el texto de la misma expresión (ALTER POLICY conserva nombre, comando y roles) y solo se
-- agrega el envoltorio. Genérico sobre TODAS las policies de public, así cubre también las que
-- no figuran en un archivo de migración.
--
-- IDEMPOTENTE: solo envuelve las lecturas que todavía no están dentro de un `( SELECT`. Al final
-- falla (y revierte) si alguna policy de public sigue leyendo el JWT fuera de una subconsulta.
-- Guardia permanente: supabase/tests/rls_initplan.sql.
do $$
declare
  -- Formas deparseadas (pg_get_expr) de las lecturas inline, sin un `( SELECT ` delante.
  re_claims constant text := $r$(?<!SELECT )\(NULLIF\(current_setting\('request\.jwt\.claims'::text, true\), ''::text\)\)::jsonb$r$;
  re_sub constant text := $r$(?<!SELECT )NULLIF\(current_setting\('request\.jwt\.claim\.sub'::text, true\), ''::text\)$r$;
  re_auth constant text := $r$(?<!SELECT )auth\.(uid|jwt|role)\(\)$r$;
  p record;
  q text;
  w text;
  n int := 0;
  restantes text;
begin
  for p in
    select pol.polname, c.relname,
           pg_get_expr(pol.polqual, pol.polrelid) as qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
     where c.relnamespace = 'public'::regnamespace
  loop
    q := p.qual;
    w := p.with_check;
    if q is not null then
      q := regexp_replace(q, re_claims, $x$( SELECT (NULLIF(current_setting('request.jwt.claims'::text, true), ''::text))::jsonb AS claims)$x$, 'g');
      q := regexp_replace(q, re_sub, $x$( SELECT NULLIF(current_setting('request.jwt.claim.sub'::text, true), ''::text) AS sub)$x$, 'g');
      q := regexp_replace(q, re_auth, $x$( SELECT auth.\1() AS \1)$x$, 'g');
    end if;
    if w is not null then
      w := regexp_replace(w, re_claims, $x$( SELECT (NULLIF(current_setting('request.jwt.claims'::text, true), ''::text))::jsonb AS claims)$x$, 'g');
      w := regexp_replace(w, re_sub, $x$( SELECT NULLIF(current_setting('request.jwt.claim.sub'::text, true), ''::text) AS sub)$x$, 'g');
      w := regexp_replace(w, re_auth, $x$( SELECT auth.\1() AS \1)$x$, 'g');
    end if;
    if q is distinct from p.qual or w is distinct from p.with_check then
      execute format('alter policy %I on public.%I', p.polname, p.relname)
        || case when q is not null then format(' using (%s)', q) else '' end
        || case when w is not null then format(' with check (%s)', w) else '' end;
      n := n + 1;
    end if;
  end loop;
  raise notice 'policies reescritas a la forma InitPlan: %', n;

  select string_agg(c.relname || '.' || pol.polname, ', ') into restantes
    from pg_policy pol join pg_class c on c.oid = pol.polrelid
   where c.relnamespace = 'public'::regnamespace
     and regexp_replace(regexp_replace(regexp_replace(
           coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''),
           $r$\( SELECT \(NULLIF\(current_setting\('request\.jwt\.claims'::text, true\), ''::text\)\)::jsonb AS claims\)$r$, '', 'g'),
           $r$\( SELECT NULLIF\(current_setting\('request\.jwt\.claim\.sub'::text, true\), ''::text\) AS sub\)$r$, '', 'g'),
           $r$\( SELECT auth\.(uid|jwt|role)\(\) AS \w+\)$r$, '', 'g')
         ~ $r$current_setting\('request\.jwt\.claim|auth\.(uid|jwt|role)\($r$;
  if restantes is not null then
    raise exception 'quedan policies que leen el JWT por fila (forma no reconocida): %', restantes;
  end if;
end $$;
