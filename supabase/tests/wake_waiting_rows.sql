-- Prueba de la migración 0094: wake_waiting_rows despierta filas que esperan lead sin gastarles
-- intentos y con tope por fila.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/wake_waiting_rows.sql   (ver supabase/tests/README.md)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

delete from inbound_queue;
insert into inbound_queue (id, payload, status, not_before, waiting_refs, last_error, attempts, processing_failures) values
  ('bbbbbbbb-0000-0000-0000-000000000001', '{}', 'pending', now() + interval '1 minute', array['talk:1'], 'lead_unresolved (no_talk_id)', 3, 0),
  ('bbbbbbbb-0000-0000-0000-000000000002', '{}', 'pending', now() + interval '1 minute', array['talk:2'], 'lead_unresolved (no_talk_id)', 3, 0),
  ('bbbbbbbb-0000-0000-0000-000000000003', '{}', 'pending', now() + interval '1 minute', array['talk:1'], 'processing_error (falla 1)', 3, 1);

create temp table woke as select wake_waiting_rows(array['talk:1']) as n;
select pg_temp.expect('despierta solo la fila que espera ESA conversación y no otra',
  (select n from woke) = 1
  and (select not_before <= now() from inbound_queue where id = 'bbbbbbbb-0000-0000-0000-000000000001')
  and (select not_before > now() from inbound_queue where id = 'bbbbbbbb-0000-0000-0000-000000000002')
  and (select not_before > now() from inbound_queue where id = 'bbbbbbbb-0000-0000-0000-000000000003'));
select pg_temp.expect('despertar no cuesta intentos: devuelve el que gasta el claim y cuenta el despertar',
  (select attempts = 2 and wake_count = 1 from inbound_queue where id = 'bbbbbbbb-0000-0000-0000-000000000001'));

-- tope por fila: tras 3 despertares ya no despierta más
update inbound_queue set not_before = now() + interval '1 minute' where id = 'bbbbbbbb-0000-0000-0000-000000000001';
select wake_waiting_rows(array['talk:1']);
update inbound_queue set not_before = now() + interval '1 minute' where id = 'bbbbbbbb-0000-0000-0000-000000000001';
select wake_waiting_rows(array['talk:1']);
update inbound_queue set not_before = now() + interval '1 minute' where id = 'bbbbbbbb-0000-0000-0000-000000000001';
create temp table woke2 as select wake_waiting_rows(array['talk:1']) as n;
select pg_temp.expect('con el tope de despertares agotado no despierta y no toca los intentos',
  (select n from woke2) = 0
  and (select not_before > now() and wake_count = 3 and attempts = 0 from inbound_queue where id = 'bbbbbbbb-0000-0000-0000-000000000001'));

select pg_temp.expect('solo service_role ejecuta la función',
  not has_function_privilege('anon', 'wake_waiting_rows(text[])', 'execute')
  and not has_function_privilege('authenticated', 'wake_waiting_rows(text[])', 'execute')
  and has_function_privilege('service_role', 'wake_waiting_rows(text[])', 'execute'));

rollback;
