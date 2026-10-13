-- =============================================================
-- 0070_function_execute_hardening.sql
-- Barrido de EXECUTE sobre las funciones de `public`: ninguna nace abierta a anon.
--
-- PROBLEMA: Postgres otorga EXECUTE a PUBLIC por default en toda función nueva, y
-- Supabase además agrega default privileges que se lo dan a anon/authenticated. La
-- anon key es PÚBLICA (va en el bundle del frontend), así que toda función con
-- EXECUTE para anon es invocable por cualquiera con la URL del proyecto — y una
-- SECURITY DEFINER bypasea la RLS. En un derivado de este template (Pocholin) se
-- encontraron `dashboard_lead_rows`, `trigger_*` y SECURITY DEFINER como
-- `analiticas_resumen` / `trigger_dreams_consolidate` ejecutables con la anon key.
--
-- FIX:
--  1) REVOKE EXECUTE de PUBLIC, anon y authenticated sobre TODAS las funciones
--     propias de `public` (las de extensiones —pgvector, pg_trgm, que viven en
--     `public`— no se tocan: no son nuestras y sus operadores los necesita el
--     planificador); GRANT explícito solo a quien corresponde:
--       · service_role (Edge Functions, cron): todas;
--       · authenticated (panel con la sesión del usuario): únicamente las dos que el
--         dashboard llama por RPC — inbox_lead_summaries() y gasto_mes_actual()
--         (grep de `.rpc(` en web/src);
--       · anon: NINGUNA. Si un derivado necesita una función pública, la declara y
--         documenta en su propia migración y en supabase/tests/function_execute.sql.
--  2) ALTER DEFAULT PRIVILEGES: las funciones FUTURAS no nacen abiertas.
--  3) Guard interno en las SECURITY DEFINER anteriores a este estándar
--     (hub_metrics, ya aplicada en producción, se redefine acá; claim_message_batch
--     y purge_retention, todavía sin aplicar, lo llevan en 0064 y 0066): si la petición trae claims de usuario
--     (un usuario con JWT) lanzan insufficient_privilege. Defensa en profundidad: el
--     REVOKE ya las cierra, el guard evita que un GRANT futuro las reabra. Todas con
--     search_path = public, pg_temp.
--
-- Funciones y su uso real (grep de .rpc( en web/ y supabase/functions, y de los crons):
--   inbox_lead_summaries, gasto_mes_actual ........ authenticated + service_role (panel)
--   search_kb, claim_inbound_batch, claim_message_batch, follow_up_due_leads,
--   apply_lead_position, apply_kommo_lead_positions, sync_kommo_pipelines,
--   claim_kommo_*, kommo_*, mark_kommo_leads_missing,
--   record_lead_stage_event ....................... service_role (Edge)
--   trigger_*, internal_function_headers, purge_retention, hub_metrics
--                                                  service_role / pg_cron (owner)
--   search_memory (sin uso hoy) ................... service_role
--   set_updated_at (función de trigger) ........... service_role (el trigger no necesita EXECUTE)
--
-- IDEMPOTENTE.
-- =============================================================

-- ── 3) Guards: se redefinen ANTES del barrido (CREATE OR REPLACE conserva los grants) ──
create or replace function public.hub_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- Guard (estándar de seguridad de Boosty): SECURITY DEFINER bypasea la RLS. Solo
  -- service_role, pg_cron y el dueño (sin claims de usuario en la petición) pueden ejecutarla; un
  -- usuario con JWT (anon/authenticated) no, aunque algún día alguien le re-otorgue
  -- EXECUTE por error.
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  return (
  with
     msg as (select
       count(*) filter (where created_at::date = now()::date)              as in_today,
       count(*) filter (where created_at > now() - interval '7 days')      as in_7d,
       count(*) filter (where created_at >= date_trunc('month', now()))    as in_month,
       max(created_at)                                                     as last_inbound
       from public.messages),
     drf as (select
       count(*) filter (where created_at::date = now()::date and sent_at is not null)          as out_today,
       count(*) filter (where created_at > now() - interval '7 days' and sent_at is not null)   as out_7d,
       count(*) filter (where created_at >= date_trunc('month', now()) and sent_at is not null) as out_month,
       count(*) filter (where created_at > now() - interval '7 days' and sent_at is null)       as shadow_7d,
       count(*) filter (where created_at > now() - interval '7 days')                           as gen_7d,
       count(*) filter (where status = 'failed' and created_at > now() - interval '7 days')     as failed_7d
       from public.drafts),
     usg as (select
       round(coalesce(sum(estimated_cost_usd) filter (where created_at::date = now()::date), 0), 2)           as cost_today,
       round(coalesce(sum(estimated_cost_usd) filter (where created_at >= date_trunc('month', now())), 0), 2) as cost_month,
       round(coalesce(sum(estimated_cost_usd) filter (where created_at > now() - interval '7 days'), 0), 2)   as cost_7d,
       coalesce(sum(input_tokens + output_tokens) filter (where created_at > now() - interval '7 days'), 0)   as tokens_7d,
       max(created_at)                                                                                        as last_event
       from public.usage_events),
     lat as (select
       round(avg(runtime_ms))                                                          as llm_avg_ms,
       round(percentile_cont(0.95) within group (order by runtime_ms))                 as llm_p95_ms
       from public.usage_events
       where component = 'generate_response' and created_at > now() - interval '7 days'),
     clat as (select
       round(percentile_cont(0.5) within group (order by extract(epoch from d.created_at - m.created_at)))  as cust_p50_s,
       round(percentile_cont(0.95) within group (order by extract(epoch from d.created_at - m.created_at))) as cust_p95_s
       from public.drafts d join public.messages m on m.id = d.message_id
       where d.created_at > now() - interval '7 days'
         and d.created_at >= m.created_at
         and d.created_at < m.created_at + interval '1 hour'),
     -- Solo backlog (pending/processing): matchea el índice parcial
     -- `inbound_queue_pending_idx` → evita el seqscan de toda la tabla (que puede
     -- tener cientos de miles de filas 'done' y tardaría segundos). La señal de
     -- fallos de respuesta ya la aporta `failed_drafts_7d` (indexado).
     q as (select
       count(*) filter (where status = 'pending')    as pending,
       count(*) filter (where status = 'processing') as processing
       from public.inbound_queue
       where status in ('pending', 'processing')),
     mdl as (select model from public.usage_events
       where created_at > now() - interval '7 days' and model is not null
       group by model order by count(*) desc limit 1)
    select jsonb_build_object(
      'schema_version', 1,
      'generated_at', now(),
      'model', (select model from mdl),
      'messages', jsonb_build_object(
        'in_today', (select in_today from msg), 'in_7d', (select in_7d from msg), 'in_month', (select in_month from msg),
        'out_today', (select out_today from drf), 'out_7d', (select out_7d from drf), 'out_month', (select out_month from drf),
        'shadow_7d', (select shadow_7d from drf), 'generated_7d', (select gen_7d from drf)),
      'cost', jsonb_build_object(
        'today', (select cost_today from usg), 'month', (select cost_month from usg),
        'd7', (select cost_7d from usg), 'tokens_7d', (select tokens_7d from usg)),
      'latency', jsonb_build_object(
        'llm_avg_ms', (select llm_avg_ms from lat), 'llm_p95_ms', (select llm_p95_ms from lat),
        'customer_p50_s', (select cust_p50_s from clat), 'customer_p95_s', (select cust_p95_s from clat)),
      'queue', jsonb_build_object(
        'pending', (select pending from q), 'processing', (select processing from q)),
      'health', jsonb_build_object(
        'last_event_at', (select last_event from usg), 'last_inbound_at', (select last_inbound from msg),
        'failed_drafts_7d', (select failed_7d from drf))
    )
  );
end;
$$;

-- ── 1) Barrido: cerrar todo y abrir lo justo ─────────────────────────────────
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

-- Lo único que el panel llama con la sesión del usuario.
grant execute on function public.inbox_lead_summaries() to authenticated;
grant execute on function public.gasto_mes_actual() to authenticated;

-- ── 2) Las funciones futuras no nacen abiertas ───────────────────────────────
-- Default privileges por rol creador: el global (PUBLIC) y los que Supabase agrega
-- en `public` para anon/authenticated. service_role conserva su acceso.
do $$
declare
  r text;
begin
  -- current_user = el rol que corre ESTAS migraciones (el que creará las funciones
  -- futuras); postgres y supabase_admin son los dueños habituales en Supabase. Sobre
  -- un rol ajeno ALTER DEFAULT PRIVILEGES exige ser miembro: si el rol de la
  -- migración no puede, se avisa y se sigue (la protección de las funciones EXISTENTES
  -- ya quedó arriba y el test supabase/tests/function_execute.sql lo verifica).
  foreach r in array array[current_user::text, 'postgres', 'supabase_admin'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      begin
        execute format('alter default privileges for role %I revoke execute on functions from public', r);
        execute format('alter default privileges for role %I in schema public revoke execute on functions from public, anon, authenticated', r);
        if exists (select 1 from pg_roles where rolname = 'service_role') then
          execute format('alter default privileges for role %I in schema public grant execute on functions to service_role', r);
        end if;
      exception when insufficient_privilege then
        raise notice 'default privileges de % no modificados (sin permiso): ejecutar como ese rol', r;
      end;
    end if;
  end loop;
end $$;
