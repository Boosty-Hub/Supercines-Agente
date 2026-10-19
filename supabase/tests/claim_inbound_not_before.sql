-- Prueba de la migración 0092: claim_inbound_batch respeta inbound_queue.not_before y devuelve
-- attempts (el contador que decide cuándo rendirse con un mensaje cuyo lead Kommo aún no creó).
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/claim_inbound_not_before.sql   (ver supabase/tests/README.md)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

delete from inbound_queue;
insert into inbound_queue (id, payload, status, not_before) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '{"k":"listo"}',   'pending', null),
  ('aaaaaaaa-0000-0000-0000-000000000002', '{"k":"vencido"}', 'pending', now() - interval '1 minute'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '{"k":"espera"}',  'pending', now() + interval '5 minutes');

create temp table claimed as select * from claim_inbound_batch(10);

select pg_temp.expect('reclama los listos y los vencidos, NO el que espera',
  (select count(*) from claimed) = 2
  and not exists (select 1 from claimed where id = 'aaaaaaaa-0000-0000-0000-000000000003'));
select pg_temp.expect('devuelve attempts ya incrementado y created_at',
  (select bool_and(attempts = 1 and created_at is not null) from claimed));
select pg_temp.expect('devuelve signed (null = encolada sin marcador) y processing_failures (0)',
  (select bool_and(signed is null and processing_failures = 0) from claimed));
select pg_temp.expect('la fila en espera sigue pending y sin tocar',
  (select status = 'pending' and attempts = 0 from inbound_queue where id = 'aaaaaaaa-0000-0000-0000-000000000003'));

-- Reintento: vuelve a pending con espera y payload reducido; no se reclama hasta vencer.
update inbound_queue set status = 'pending', not_before = now() + interval '30 seconds',
  payload = '{"message":{"add":[]}}'
 where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.expect('un reintento con espera futura no se reclama',
  not exists (select 1 from claim_inbound_batch(10) where id = 'aaaaaaaa-0000-0000-0000-000000000001'));
update inbound_queue set not_before = now() - interval '1 second' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.expect('vencida la espera se reclama con attempts = 2',
  (select attempts = 2 from claim_inbound_batch(10) where id = 'aaaaaaaa-0000-0000-0000-000000000001'));

-- ---- Filas que esperan lead (waiting_refs): tope propio del reaper + alerta, nunca silencioso ----
delete from inbound_queue;
insert into inbound_queue (id, payload, status, attempts, claimed_at, waiting_refs, signed) values
  -- esperando lead, murió procesando en su ÚLTIMO intento (7) con un mensaje del cliente
  ('bbbbbbbb-0000-0000-0000-000000000001',
   '{"message":{"add":[{"id":"m1","type":"incoming","talk_id":"9001"}]}}', 'processing', 7,
   now() - interval '11 minutes', array['talk:9001','contact:7777'], true),
  -- esperando lead, murió en el intento 6: se RECUPERA (el tope general de 5 no la mata)
  ('bbbbbbbb-0000-0000-0000-000000000002',
   '{"message":{"add":[{"id":"m2","type":"incoming","talk_id":"9002"}]}}', 'processing', 6,
   now() - interval '11 minutes', array['talk:9002'], true),
  -- fila común (sin espera) en su intento 5: failed CON alerta inbound_processing_failed
  ('bbbbbbbb-0000-0000-0000-000000000003',
   '{"message":{"add":[{"id":"m3","type":"incoming","entity_id":"5"}]}}', 'processing', 5,
   now() - interval '11 minutes', null, true),
  -- esperando lead, solo un saliente: failed sin alerta (no hay cliente sin respuesta)
  ('bbbbbbbb-0000-0000-0000-000000000004',
   '{"message":{"add":[{"id":"m4","type":"outgoing","talk_id":"9004"}]}}', 'processing', 7,
   now() - interval '11 minutes', array['talk:9004'], true),
  -- SIN FIRMA (la pudo forjar cualquiera con la URL), murió en el intento 5 con un mensaje del
  -- cliente: failed y alerta AGREGADA (inbound_dropped), nunca una crítica por fila
  ('bbbbbbbb-0000-0000-0000-000000000005',
   '{"message":{"add":[{"id":"m5","type":"incoming","entity_id":"5"}]}}', 'processing', 5,
   now() - interval '11 minutes', null, false),
  -- encolada antes de 0092 (signed null) esperando lead: también agregada
  ('bbbbbbbb-0000-0000-0000-000000000006',
   '{"message":{"add":[{"id":"m6","type":"incoming","talk_id":"9006"}]}}', 'processing', 7,
   now() - interval '11 minutes', array['talk:9006'], null);

create temp table claimed2 as select * from claim_inbound_batch(10);

select pg_temp.expect('la fila en espera que murió en su último intento queda failed',
  (select status = 'failed' from inbound_queue where id = 'bbbbbbbb-0000-0000-0000-000000000001'));
select pg_temp.expect('…y deja UNA alerta inbound_lead_unresolved con ref_id = fila',
  (select count(*) = 1 from alerts
    where kind = 'inbound_lead_unresolved' and ref_id = 'bbbbbbbb-0000-0000-0000-000000000001'
      and severity = 'critical' and metadata ->> 'motivo' = 'worker_muerto'));
select pg_temp.expect('la fila en espera del intento 6 se recupera (attempts = 7)',
  exists (select 1 from claimed2 where id = 'bbbbbbbb-0000-0000-0000-000000000002' and attempts = 7));
select pg_temp.expect('la fila común del intento 5 queda failed, sin alerta de lead y CON inbound_processing_failed (una)',
  (select status = 'failed' from inbound_queue where id = 'bbbbbbbb-0000-0000-0000-000000000003')
  and not exists (select 1 from alerts where ref_id = 'bbbbbbbb-0000-0000-0000-000000000003' and kind = 'inbound_lead_unresolved')
  and (select count(*) = 1 from alerts where ref_id = 'bbbbbbbb-0000-0000-0000-000000000003'
         and kind = 'inbound_processing_failed' and severity = 'critical'));
with ins as (
  insert into alerts (kind, severity, title, ref_table, ref_id)
  values ('inbound_processing_failed', 'critical', 't', 'inbound_queue', 'bbbbbbbb-0000-0000-0000-000000000003')
  on conflict do nothing returning 1)
select pg_temp.expect('la copia de inbound_processing_failed por fila es rechazada (índice único)',
  (select count(*) = 0 from ins));
select pg_temp.expect('L3: el texto del reaper no afirma que el mensaje no entró',
  (select bool_and(description like '%puede no haber entrado%') from alerts
    where ref_id in ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000003')));
select pg_temp.expect('H2: filas sin firma (false o null) mueren SIN alertas por fila',
  (select bool_and(status = 'failed') from inbound_queue
    where id in ('bbbbbbbb-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-000000000006'))
  and not exists (select 1 from alerts where ref_id in ('bbbbbbbb-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-000000000006')));
select pg_temp.expect('…y dejan UNA alerta agregada inbound_dropped (las dos suman al contador)',
  (select count(*) = 1 and max(agg_count) = 2 and bool_and(metadata ->> 'motivo' = 'worker_muerto_sin_firma')
     from alerts where kind = 'inbound_dropped' and agg_key is not null));
select pg_temp.expect('una espera con solo salientes no alerta',
  (select status = 'failed' from inbound_queue where id = 'bbbbbbbb-0000-0000-0000-000000000004')
  and not exists (select 1 from alerts where ref_id = 'bbbbbbbb-0000-0000-0000-000000000004'));

-- La misma pérdida no duplica la alerta (índice único ampliado en 0092).
insert into alerts (kind, severity, title, ref_table, ref_id)
values ('inbound_lead_unresolved', 'critical', 't', 'inbound_queue', 'bbbbbbbb-0000-0000-0000-000000000001')
on conflict do nothing;
select pg_temp.expect('una sola alerta por fila de la cola',
  (select count(*) = 1 from alerts where kind = 'inbound_lead_unresolved'
     and ref_id = 'bbbbbbbb-0000-0000-0000-000000000001'));

-- Despertar: un mensaje del mismo talk adelanta la espera (lo que hace process-inbound).
insert into inbound_queue (id, payload, status, not_before, waiting_refs) values
  ('cccccccc-0000-0000-0000-000000000001', '{"message":{"add":[]}}', 'pending', now() + interval '3 minutes', array['talk:9100','contact:1']),
  ('cccccccc-0000-0000-0000-000000000002', '{"message":{"add":[]}}', 'pending', now() + interval '3 minutes', array['talk:9200']);
update inbound_queue set not_before = now()
 where status = 'pending' and waiting_refs && array['talk:9100','chat:x'] and not_before > now();
select pg_temp.expect('despertar toca SOLO la fila del mismo talk',
  (select not_before <= now() from inbound_queue where id = 'cccccccc-0000-0000-0000-000000000001')
  and (select not_before > now() from inbound_queue where id = 'cccccccc-0000-0000-0000-000000000002'));
select pg_temp.expect('el contacto se encuentra con @> (lo que consulta generate-response)',
  exists (select 1 from inbound_queue where waiting_refs @> array['contact:1']));

select pg_temp.expect('el default de webhook_kinds incluye inbound_lead_unresolved e inbound_processing_failed',
  (select column_default like '%inbound_lead_unresolved%' and column_default like '%inbound_processing_failed%' from information_schema.columns
    where table_schema = 'public' and table_name = 'alert_config' and column_name = 'webhook_kinds'));

-- M1: processing_failures es una columna aparte de attempts (claims).
select pg_temp.expect('inbound_queue.processing_failures existe, no nula, default 0',
  (select is_nullable = 'NO' and column_default = '0' from information_schema.columns
    where table_schema = 'public' and table_name = 'inbound_queue' and column_name = 'processing_failures'));

-- L2 / seguridad: messages.inserted_at (hora REAL de inserción) y la reserva condicional del retomar.
delete from leads where kommo_lead_id in (990001, 990002);
insert into leads (id, kommo_lead_id) values
  ('dddddddd-0000-0000-0000-000000000001', 990001),
  ('dddddddd-0000-0000-0000-000000000002', 990002);
insert into messages (id, lead_id, direction, content, kommo_message_id, created_at, inserted_at) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'inbound', 'hola', 'km-resume-1',
   now() - interval '2 days', now() - interval '5 minutes');
with i as (
  insert into messages (lead_id, direction, content, created_at)
  values ('dddddddd-0000-0000-0000-000000000001', 'inbound', 'x', now() - interval '3 days')
  returning inserted_at)
select pg_temp.expect('inserted_at nace con now() aunque created_at venga sellado con la llegada',
  (select inserted_at > now() - interval '1 minute' from i));
-- Payload hostil: OTRO lead reusa el kommo_message_id → la reserva no toca la fila.
with c as (
  update messages set classification = '{"error":"resume: clasificación retomada en curso"}'
   where id = 'eeeeeeee-0000-0000-0000-000000000001' and lead_id = 'dddddddd-0000-0000-0000-000000000002'
     and direction = 'inbound' and ignored = false and vertical_id is null and classification is null
     and inserted_at < now() - interval '45 seconds'
  returning id)
select pg_temp.expect('seguridad: otro lead no puede retomar el mensaje', (select count(*) = 0 from c));
-- Dos invocaciones del lead correcto: solo una gana la reserva.
create temp table resume_claims (n int);
with c as (
  update messages set classification = '{"error":"resume: clasificación retomada en curso"}'
   where id = 'eeeeeeee-0000-0000-0000-000000000001' and lead_id = 'dddddddd-0000-0000-0000-000000000001'
     and direction = 'inbound' and ignored = false and vertical_id is null and classification is null
     and inserted_at < now() - interval '45 seconds'
  returning id)
insert into resume_claims select count(*) from c;
with c as (
  update messages set classification = '{"error":"resume: clasificación retomada en curso"}'
   where id = 'eeeeeeee-0000-0000-0000-000000000001' and lead_id = 'dddddddd-0000-0000-0000-000000000001'
     and direction = 'inbound' and ignored = false and vertical_id is null and classification is null
     and inserted_at < now() - interval '45 seconds'
  returning id)
insert into resume_claims select count(*) from c;
select pg_temp.expect('la reserva del retomar la gana UNA sola invocación',
  (select array_agg(n order by n) = array[0, 1] from resume_claims));

select pg_temp.expect('solo service_role ejecuta la RPC',
  not has_function_privilege('anon', 'claim_inbound_batch(int)', 'execute')
  and not has_function_privilege('authenticated', 'claim_inbound_batch(int)', 'execute')
  and has_function_privilege('service_role', 'claim_inbound_batch(int)', 'execute'));

rollback;
