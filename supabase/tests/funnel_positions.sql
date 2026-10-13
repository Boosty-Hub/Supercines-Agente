-- Prueba de reconcile_funnel_lead_positions (migración 0062) contra un Postgres
-- con TODAS las migraciones aplicadas (descartable: borra leads).
--
--   sed 's#${SUPABASE_URL}#http://x.test#g' supabase/migrations/*.sql | psql ...   (una vez)
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/funnel_positions.sql
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

delete from leads where true;
delete from kommo_backfill_seen where true;
insert into leads (kommo_lead_id, kommo_pipeline_id, kommo_stage_id) values
  (1001, null, null), (1002, 7847207, 100), (1003, 7847207, 100);
update leads set kommo_missing_at = now() where kommo_lead_id = 1003;

select pg_temp.expect('cambia solo lo que cambió (1001 nuevo + 1003 con marca; 1002 igual)',
  reconcile_funnel_lead_positions('[
    {"id":1001,"pipeline_id":7847207,"status_id":200},
    {"id":1002,"pipeline_id":7847207,"status_id":100},
    {"id":1003,"pipeline_id":7847207,"status_id":100},
    {"id":9999,"pipeline_id":7847207,"status_id":100}
  ]'::jsonb) = 2);
select pg_temp.expect('1001 quedó ubicado',
  (select kommo_pipeline_id = 7847207 and kommo_stage_id = 200 from leads where kommo_lead_id = 1001));
select pg_temp.expect('1003 perdió la marca «no existe en Kommo»',
  (select kommo_missing_at is null from leads where kommo_lead_id = 1003));
select pg_temp.expect('un lead que no está en la base no se crea', (select count(*) = 3 from leads));
select pg_temp.expect('no ensucia kommo_backfill_seen (no es un recorrido completo)',
  (select count(*) = 0 from kommo_backfill_seen));
select pg_temp.expect('segunda pasada = idempotente (0 cambios)',
  reconcile_funnel_lead_positions('[{"id":1001,"pipeline_id":7847207,"status_id":200}]'::jsonb) = 0);
select pg_temp.expect('entrada vacía o inválida = 0',
  reconcile_funnel_lead_positions('[]'::jsonb) = 0 and reconcile_funnel_lead_positions(null) = 0);
select pg_temp.expect('anon no puede ejecutarla', not has_function_privilege('anon', 'reconcile_funnel_lead_positions(jsonb)', 'EXECUTE'));
select pg_temp.expect('authenticated no puede ejecutarla', not has_function_privilege('authenticated', 'reconcile_funnel_lead_positions(jsonb)', 'EXECUTE'));
select pg_temp.expect('anon no puede disparar el cron del funnel', not has_function_privilege('anon', 'trigger_kommo_funnel_sync()', 'EXECUTE'));

rollback;
