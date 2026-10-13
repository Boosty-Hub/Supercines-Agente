-- =============================================================
-- 0063_revoke_anon_functions.sql
-- Cierra funciones SQL de public ejecutables por `anon` (la anon key es PÚBLICA).
-- Medido en producción (catálogo, has_function_privilege): anon podía ejecutar
-- 13 funciones propias, entre ellas claim_inbound_batch (reclama filas de la cola
-- de ingesta: con la anon key se podía frenar la ingesta), follow_up_due_leads,
-- search_kb/search_memory y los trigger_* de cron (cada uno hace net.http_post a
-- una Edge Function: disparables en bucle = gasto de IA). Postgres da EXECUTE a
-- PUBLIC por defecto.
--
-- 1) TODA función propia de public (no de extensiones) pierde EXECUTE de PUBLIC y
--    anon, y lo conserva service_role (Edge Functions).
-- 2) Las que solo usan pg_cron (como postgres) o las Edge Functions (service_role)
--    pierden además el de authenticated. Las que el panel llama con la sesión del
--    usuario (inbox_lead_summaries, record_lead_stage_event, gasto_mes_actual)
--    NO se tocan para authenticated: esta migración no depende de 0060/0061 y es
--    segura aplicada antes o después de ellas.
-- 3) Las funciones FUTURAS ya no heredan EXECUTE de PUBLIC.
-- IDEMPOTENTE.
-- =============================================================
do $$
declare
  r record;
  v_service_only text[] := array[
    'claim_inbound_batch', 'follow_up_due_leads', 'next_round_robin_assignee',
    'search_kb', 'search_memory', 'set_updated_at',
    'reconcile_funnel_lead_positions', 'apply_kommo_lead_positions', 'mark_kommo_missing_leads',
    'sync_kommo_pipelines', 'claim_kommo_backfill', 'claim_kommo_pipelines_refresh'
  ];
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
 left join pg_depend d on d.objid = p.oid and d.deptype = 'e'   -- excluye las de extensiones
     where n.nspname = 'public' and p.prokind = 'f' and d.objid is null
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.proname like 'trigger\_%' or r.proname = any (v_service_only) then
      execute format('revoke execute on function %s from authenticated', r.sig);
    end if;
  end loop;
end $$;

alter default privileges in schema public revoke execute on functions from public;
