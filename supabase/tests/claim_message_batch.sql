-- Prueba de claim_message_batch (0064) y purge_retention (0066) contra un Postgres
-- con TODAS las migraciones aplicadas (descartable: borra leads).
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/claim_message_batch.sql
begin;
create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

delete from leads where true;
insert into leads (id, kommo_lead_id) values ('00000000-0000-0000-0000-0000000000a1', 5001);
insert into messages (id, lead_id, direction, content) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'inbound', 'uno'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'inbound', 'dos');
insert into drafts (id, message_id, body, status) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b2', '', 'pending'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b2', '', 'pending');

select pg_temp.expect('el primero reclama el lote completo (2)',
  claim_message_batch(array['00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2']::uuid[], '00000000-0000-0000-0000-0000000000c1') = 2);
select pg_temp.expect('el segundo (concurrente) no gana nada (0)',
  claim_message_batch(array['00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2']::uuid[], '00000000-0000-0000-0000-0000000000c2') = 0);
select pg_temp.expect('el lote quedó atado al draft ganador',
  (select count(*) = 2 from messages where answered_by_draft_id = '00000000-0000-0000-0000-0000000000c1'));
select pg_temp.expect('anon/authenticated no pueden reclamar',
  not has_function_privilege('anon', 'claim_message_batch(uuid[], uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'claim_message_batch(uuid[], uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'claim_message_batch(uuid[], uuid)', 'EXECUTE'));
select pg_temp.expect('purge_retention solo para service_role',
  not has_function_privilege('anon', 'purge_retention()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'purge_retention()', 'EXECUTE'));

insert into alerts (kind, severity, title, description, created_at) values
  ('draft_failed', 'info', 't', 'd', now() - interval '8 days'),
  ('budget_exceeded', 'info', 't', 'd', now() - interval '40 days'),
  ('inbound_silence', 'info', 't', 'd', now() - interval '40 days');
select pg_temp.expect('retención: draft_failed >7d y resto >30d se purgan; budget_exceeded de 40d se conserva',
  (select coalesce(sum(borradas),0) from purge_retention() where tabla like 'alerts%') = 2
  and (select count(*) from alerts where kind = 'budget_exceeded') = 1);
rollback;
