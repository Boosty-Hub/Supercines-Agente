-- Prueba de 0091 (+ 0092): UNA alerta por entidad para draft_failed / human_review_needed /
-- inbound_lead_unresolved.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/alerts_una_por_entidad.sql   (ver supabase/tests/README.md)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- Una instalación de antes de 0091, con el bucle ya corriendo: copias de la misma entidad.
drop index if exists public.alerts_una_por_entidad_uidx;
drop index if exists public.alerts_una_por_entidad_v2_uidx;
delete from public.alerts;
insert into public.alerts (kind, severity, title, ref_table, ref_id, created_at, acknowledged_at) values
  ('human_review_needed', 'warning', 'vieja',    'messages', 'cccccccc-0000-0000-0000-000000000001', now() - interval '3 hours', null),
  ('human_review_needed', 'warning', 'atendida', 'messages', 'cccccccc-0000-0000-0000-000000000001', now() - interval '2 hours', now()),
  ('human_review_needed', 'warning', 'copia',    'messages', 'cccccccc-0000-0000-0000-000000000001', now() - interval '1 hour',  null),
  ('draft_failed',        'warning', 'primera',  'drafts',   'cccccccc-0000-0000-0000-000000000002', now() - interval '2 hours', null),
  ('draft_failed',        'warning', 'copia',    'drafts',   'cccccccc-0000-0000-0000-000000000002', now() - interval '1 hour',  null),
  -- Tipos que SÍ repiten entidad, y una alerta sin ref_id: no se tocan.
  ('outbound_blocked',    'warning', 'a',        'drafts',   'cccccccc-0000-0000-0000-000000000002', now(), null),
  ('outbound_blocked',    'warning', 'b',        'drafts',   'cccccccc-0000-0000-0000-000000000002', now(), null),
  ('human_review_needed', 'warning', 'sin ref',  'messages', null, now(), null),
  ('human_review_needed', 'warning', 'sin ref',  'messages', null, now(), null),
  ('inbound_lead_unresolved', 'critical', 'primera', 'inbound_queue', 'cccccccc-0000-0000-0000-000000000003', now() - interval '1 hour', null),
  ('inbound_lead_unresolved', 'critical', 'copia',   'inbound_queue', 'cccccccc-0000-0000-0000-000000000003', now(), null);

\ir ../migrations/0091_alerts_una_por_entidad.sql
\ir ../migrations/0091_alerts_una_por_entidad.sql
\ir ../migrations/0092_inbound_queue_not_before.sql
\ir ../migrations/0092_inbound_queue_not_before.sql

select pg_temp.expect('0092 deja una sola inbound_lead_unresolved por fila de la cola (la más vieja)',
  (select array_agg(title) from public.alerts
    where kind = 'inbound_lead_unresolved' and ref_id = 'cccccccc-0000-0000-0000-000000000003') = array['primera']);
select pg_temp.expect('0092 reemplaza el índice de 0091 por el ampliado',
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'alerts_una_por_entidad_v2_uidx')
  and not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'alerts_una_por_entidad_uidx'));

select pg_temp.expect('queda una sola human_review_needed por mensaje, y es la ya atendida',
  (select array_agg(title) from public.alerts
    where kind = 'human_review_needed' and ref_id = 'cccccccc-0000-0000-0000-000000000001') = array['atendida']);
select pg_temp.expect('sin una atendida queda la más vieja',
  (select array_agg(title) from public.alerts
    where kind = 'draft_failed' and ref_id = 'cccccccc-0000-0000-0000-000000000002') = array['primera']);
select pg_temp.expect('los tipos que repiten entidad y las alertas sin ref_id no se borran',
  (select count(*) from public.alerts where kind = 'outbound_blocked') = 2
  and (select count(*) from public.alerts where ref_id is null) = 2);

-- La base rechaza la copia, aunque el chequeo previo de alerts-scan falle o llegue cortado.
do $$
begin
  begin
    insert into public.alerts (kind, severity, title, ref_table, ref_id)
      values ('draft_failed', 'warning', 'otra', 'drafts', 'cccccccc-0000-0000-0000-000000000002');
    raise exception 'FALLO: la copia no debió insertarse';
  exception when unique_violation then
    raise notice 'ok: una copia de draft_failed para la misma entidad es rechazada (23505)';
  end;
end $$;

do $$
begin
  begin
    insert into public.alerts (kind, severity, title, ref_table, ref_id)
      values ('inbound_lead_unresolved', 'critical', 'otra', 'inbound_queue', 'cccccccc-0000-0000-0000-000000000003');
    raise exception 'FALLO: la copia no debió insertarse';
  exception when unique_violation then
    raise notice 'ok: una copia de inbound_lead_unresolved para la misma fila es rechazada (23505)';
  end;
end $$;

insert into public.alerts (kind, severity, title, ref_table, ref_id)
  values ('outbound_blocked', 'warning', 'c', 'drafts', 'cccccccc-0000-0000-0000-000000000002');
select pg_temp.expect('outbound_blocked puede repetir entidad',
  (select count(*) from public.alerts where kind = 'outbound_blocked') = 3);

select pg_temp.expect('existe el índice por (kind, created_at)',
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'alerts_kind_created_idx'));

rollback;
