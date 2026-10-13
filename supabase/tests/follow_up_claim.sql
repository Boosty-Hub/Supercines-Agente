-- Prueba de la reserva por lead y paso del seguimiento (migración 0075) contra un
-- Postgres con TODAS las migraciones aplicadas (descartable: todo dentro de una
-- transacción que termina en rollback):
--   · claim_follow_up (de dos reservas del mismo lead+paso gana una; paso cambiado; terminal),
--   · release_follow_up_claim / mark_follow_up_sending / finish_follow_up (solo el dueño;
--     la marca exige el lease vigente; con la marca ya no se puede soltar),
--   · finish_follow_up `sent` avanza el lead en la misma transacción (y respeta responded),
--   · recover_dead_follow_up_claims (requeued / gave_up / resolve; nunca reenvía lo marcado),
--   · «sin confirmar» y tope de interrupciones: el barrido no reintenta; a mano sí,
--   · índices únicos (doble registro imposible), follow_up_due_leads excluye lo bloqueado,
--   · RLS (el panel solo lee follow_ups), guard de JWT y permisos.
--
--   sed 's#${SUPABASE_URL}#http://x.test#g' supabase/migrations/*.sql | psql ...   (una vez)
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/follow_up_claim.sql
--
-- La carrera REAL entre dos sesiones (lock de la fila del lead) se prueba aparte con dos
-- conexiones; acá se prueban las guardas que la hacen segura.
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- Reserva → (id, motivo) como texto 'motivo' para comparar fácil.
create or replace function pg_temp.claim(p_lead uuid, p_step int, p_owner uuid,
                                         p_manual boolean default false, p_confirm boolean default false)
returns text language sql as $$
  select reason from claim_follow_up(p_lead, p_step, null, p_owner, 600, p_manual, p_confirm)
$$;
create or replace function pg_temp.fid(p_lead uuid) returns uuid language sql as $$
  select id from follow_ups where lead_id = p_lead and status = 'claimed'
$$;

delete from follow_ups where true;
delete from drafts where true;
delete from messages where true;
delete from leads where true;

insert into leads (id, kommo_lead_id, display_name, last_inbound_at) values
  ('00000000-0000-0000-0000-00000000a001', 9001, 'Lead uno',    now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000a002', 9002, 'Lead dos',    now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000a003', 9003, 'Lead tres',   now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000a004', 9004, 'Lead cuatro', now() - interval '2 hours');

-- 1) Doble reserva del mismo lead+paso: solo una gana.
select pg_temp.expect('el cron reserva lead uno, paso 1',
  pg_temp.claim('00000000-0000-0000-0000-00000000a001', 1, '00000000-0000-0000-0000-0000000000aa') = 'claimed');
select pg_temp.expect('el reintento manual (otro dueño) sobre el mismo lead+paso NO reserva: in_flight',
  pg_temp.claim('00000000-0000-0000-0000-00000000a001', 1, '00000000-0000-0000-0000-0000000000bb', true, true) = 'in_flight');
select pg_temp.expect('pedir un paso que no es el siguiente: step_changed',
  pg_temp.claim('00000000-0000-0000-0000-00000000a002', 2, '00000000-0000-0000-0000-0000000000bb') = 'step_changed');
select pg_temp.expect('la reserva es una fila claimed con dueño, lease ~10 min y sin marca',
  (select count(*) = 1 and bool_and(claim_owner = '00000000-0000-0000-0000-0000000000aa'
          and lease_until between now() + interval '590 seconds' and now() + interval '610 seconds'
          and sending_at is null and step = 1)
     from follow_ups where lead_id = '00000000-0000-0000-0000-00000000a001'));
do $$ begin
  perform claim_follow_up('00000000-0000-0000-0000-00000000a002', 1, null, '00000000-0000-0000-0000-0000000000aa', 0, false, false);
  raise exception 'FALLO: lease 0 aceptado';
exception when invalid_parameter_value then raise notice 'ok: lease 0 rechazado';
end $$;

-- 2) Release / marca / cierre con token ajeno: no hacen nada.
select pg_temp.expect('release con token ajeno NO libera',
  release_follow_up_claim(pg_temp.fid('00000000-0000-0000-0000-00000000a001'), '00000000-0000-0000-0000-0000000000bb') = false);
select pg_temp.expect('marca con token ajeno NO marca',
  mark_follow_up_sending(pg_temp.fid('00000000-0000-0000-0000-00000000a001'), '00000000-0000-0000-0000-0000000000bb', null, null) = false);
select pg_temp.expect('cierre con token ajeno NO cierra',
  finish_follow_up(pg_temp.fid('00000000-0000-0000-0000-00000000a001'), '00000000-0000-0000-0000-0000000000bb', 'sent', null, null, 3) = false);
select pg_temp.expect('la reserva sigue viva y del dueño original',
  (select claim_owner = '00000000-0000-0000-0000-0000000000aa' and status = 'claimed'
     from follow_ups where lead_id = '00000000-0000-0000-0000-00000000a001'));

-- 3) El dueño marca (write-ahead) y, con la marca, ya no puede soltar la reserva.
select pg_temp.expect('el dueño marca el envío con la foto y las variables',
  mark_follow_up_sending(pg_temp.fid('00000000-0000-0000-0000-00000000a001'), '00000000-0000-0000-0000-0000000000aa',
                         array['e1'], '{"nombre":"Ana"}'::jsonb) = true);
select pg_temp.expect('con la marca puesta, release NO suelta (la plantilla pudo haber salido)',
  release_follow_up_claim(pg_temp.fid('00000000-0000-0000-0000-00000000a001'), '00000000-0000-0000-0000-0000000000aa') = false);

-- 4) Cierre `sent`: avanza el lead en la misma transacción.
select pg_temp.expect('el dueño registra el envío',
  finish_follow_up((select id from follow_ups where lead_id = '00000000-0000-0000-0000-00000000a001'),
                   '00000000-0000-0000-0000-0000000000aa', 'sent', null, null, 3) = true);
select pg_temp.expect('fila sent, sin dueño, con variables y la foto como auditoría',
  (select status = 'sent' and claim_owner is null and lease_until is null and variables ->> 'nombre' = 'Ana'
          and baseline = array['e1'] and sending_at is not null
     from follow_ups where lead_id = '00000000-0000-0000-0000-00000000a001'));
select pg_temp.expect('el lead avanzó al paso 1, active, con último envío',
  (select follow_up_step = 1 and follow_up_status = 'active' and follow_up_last_sent_at is not null
     from leads where id = '00000000-0000-0000-0000-00000000a001'));
select pg_temp.expect('un barrido que había elegido el paso 1 antes del envío: step_changed (no reenvía)',
  pg_temp.claim('00000000-0000-0000-0000-00000000a001', 1, '00000000-0000-0000-0000-0000000000cc') = 'step_changed');
-- Aunque el lead «retrocediera» (dato corrupto), el paso enviado no se reserva de nuevo.
update leads set follow_up_step = 0 where id = '00000000-0000-0000-0000-00000000a001';
select pg_temp.expect('paso ya enviado: already_sent, ni siquiera a mano confirmando',
  pg_temp.claim('00000000-0000-0000-0000-00000000a001', 1, '00000000-0000-0000-0000-0000000000cc', true, true) = 'already_sent');
update leads set follow_up_step = 1 where id = '00000000-0000-0000-0000-00000000a001';

-- 5) Índices únicos: imposible registrar dos veces el mismo paso o dos reservas vivas.
do $$ begin
  insert into follow_ups (lead_id, step, status) values ('00000000-0000-0000-0000-00000000a001', 1, 'sent');
  raise exception 'FALLO: doble registro sent del mismo lead+paso aceptado';
exception when unique_violation then raise notice 'ok: doble registro sent del mismo lead+paso rechazado';
end $$;
select pg_temp.expect('paso 2 del lead uno se reserva', pg_temp.claim('00000000-0000-0000-0000-00000000a001', 2, '00000000-0000-0000-0000-0000000000aa') = 'claimed');
do $$ begin
  insert into follow_ups (lead_id, step, status, claim_owner, lease_until)
  values ('00000000-0000-0000-0000-00000000a001', 3, 'claimed', gen_random_uuid(), now() + interval '1 minute');
  raise exception 'FALLO: segunda reserva viva del mismo lead aceptada';
exception when unique_violation then raise notice 'ok: segunda reserva viva del mismo lead rechazada';
end $$;
do $$ begin
  insert into follow_ups (lead_id, step, status) values ('00000000-0000-0000-0000-00000000a002', 1, 'claimed');
  raise exception 'FALLO: claimed sin dueño aceptado';
exception when check_violation then raise notice 'ok: claimed sin dueño/lease rechazado';
end $$;
do $$ begin
  insert into follow_ups (lead_id, step, status) values ('00000000-0000-0000-0000-00000000a002', 1, 'enviando');
  raise exception 'FALLO: estado desconocido aceptado';
exception when check_violation then raise notice 'ok: estado desconocido rechazado';
end $$;
-- Respeta responded: el lead contestó mientras se enviaba → no se reabre la secuencia.
update leads set follow_up_status = 'responded' where id = '00000000-0000-0000-0000-00000000a001';
select finish_follow_up(pg_temp.fid('00000000-0000-0000-0000-00000000a001'), '00000000-0000-0000-0000-0000000000aa', 'sent', null, null, 3);
select pg_temp.expect('envío registrado con el lead en responded: avanza el paso y sigue responded',
  (select follow_up_step = 2 and follow_up_status = 'responded' from leads where id = '00000000-0000-0000-0000-00000000a001'));
select pg_temp.expect('lead terminal (responded): no se reserva',
  pg_temp.claim('00000000-0000-0000-0000-00000000a001', 3, '00000000-0000-0000-0000-0000000000aa') = 'terminal');

-- 6) Lease vencido SIN marca → reclamable (requeued), con tope de interrupciones.
select pg_temp.claim('00000000-0000-0000-0000-00000000a002', 1, '00000000-0000-0000-0000-0000000000aa');
update follow_ups set lease_until = now() - interval '1 second' where lead_id = '00000000-0000-0000-0000-00000000a002' and status = 'claimed';
select pg_temp.expect('con el lease vencido el dueño ya no puede marcar (no envía)',
  mark_follow_up_sending(pg_temp.fid('00000000-0000-0000-0000-00000000a002'), '00000000-0000-0000-0000-0000000000aa', null, null) = false);
select pg_temp.expect('reserva muerta todavía sin barrer: otro no reserva (in_flight)',
  pg_temp.claim('00000000-0000-0000-0000-00000000a002', 1, '00000000-0000-0000-0000-0000000000bb') = 'in_flight');
create temp table rec1 as select * from recover_dead_follow_up_claims('00000000-0000-0000-0000-0000000000ee', 600, 20);
select pg_temp.expect('recover: requeued para el lead dos',
  (select count(*) = 1 and bool_and(action = 'requeued' and lead_id = '00000000-0000-0000-0000-00000000a002') from rec1));
select pg_temp.expect('la reserva muerta queda failed + interrupted, sin dueño',
  (select count(*) = 1 and bool_and(interrupted and claim_owner is null and error like '%no salió nada%')
     from follow_ups where lead_id = '00000000-0000-0000-0000-00000000a002' and status = 'failed'));
select pg_temp.expect('el paso vuelve a ser reservable',
  pg_temp.claim('00000000-0000-0000-0000-00000000a002', 1, '00000000-0000-0000-0000-0000000000bb') = 'claimed');
-- Segunda y tercera muerte → gave_up en la tercera.
update follow_ups set lease_until = now() - interval '1 second' where lead_id = '00000000-0000-0000-0000-00000000a002' and status = 'claimed';
select pg_temp.expect('segunda muerte: requeued',
  (select bool_and(action = 'requeued') from recover_dead_follow_up_claims('00000000-0000-0000-0000-0000000000ee', 600, 20)));
select pg_temp.claim('00000000-0000-0000-0000-00000000a002', 1, '00000000-0000-0000-0000-0000000000bb');
update follow_ups set lease_until = now() - interval '1 second' where lead_id = '00000000-0000-0000-0000-00000000a002' and status = 'claimed';
select pg_temp.expect('tercera muerte: gave_up',
  (select bool_and(action = 'gave_up') from recover_dead_follow_up_claims('00000000-0000-0000-0000-0000000000ee', 600, 20)));
select pg_temp.expect('en el tope: el barrido NO reserva (interrupted_cap)',
  pg_temp.claim('00000000-0000-0000-0000-00000000a002', 1, '00000000-0000-0000-0000-0000000000bb') = 'interrupted_cap');
select pg_temp.expect('en el tope: a mano SÍ (decisión humana)',
  pg_temp.claim('00000000-0000-0000-0000-00000000a002', 1, '00000000-0000-0000-0000-0000000000bb', true, false) = 'claimed');
select pg_temp.expect('el dueño suelta sin marca (el agente decidió no escribir)',
  release_follow_up_claim(pg_temp.fid('00000000-0000-0000-0000-00000000a002'), '00000000-0000-0000-0000-0000000000bb') = true);
select pg_temp.expect('la reserva soltada desaparece',
  pg_temp.fid('00000000-0000-0000-0000-00000000a002') is null);

-- 7) Lease vencido CON marca → nunca se reenvía: se retoma solo para resolver.
select pg_temp.claim('00000000-0000-0000-0000-00000000a003', 1, '00000000-0000-0000-0000-0000000000aa');
select mark_follow_up_sending(pg_temp.fid('00000000-0000-0000-0000-00000000a003'), '00000000-0000-0000-0000-0000000000aa', array['e1', 'e2'], null);
update follow_ups set lease_until = now() - interval '1 second' where lead_id = '00000000-0000-0000-0000-00000000a003' and status = 'claimed';
create temp table rec2 as select * from recover_dead_follow_up_claims('00000000-0000-0000-0000-0000000000ee', 600, 20);
select pg_temp.expect('recover: resolve para el lead tres (nada más)',
  (select array_agg(action) = array['resolve'] and bool_and(lead_id = '00000000-0000-0000-0000-00000000a003') from rec2));
select pg_temp.expect('sigue claimed, retomada por el resolvedor con lease nuevo y la foto intacta',
  (select status = 'claimed' and claim_owner = '00000000-0000-0000-0000-0000000000ee' and lease_until > now()
          and baseline = array['e1', 'e2']
     from follow_ups where lead_id = '00000000-0000-0000-0000-00000000a003'));
select pg_temp.expect('mientras se resuelve: nadie reserva ese lead (ni a mano confirmando)',
  pg_temp.claim('00000000-0000-0000-0000-00000000a003', 1, '00000000-0000-0000-0000-0000000000bb', true, true) = 'in_flight');
select pg_temp.expect('segunda pasada inmediata: nada que recuperar',
  (select count(*) = 0 from recover_dead_follow_up_claims('00000000-0000-0000-0000-0000000000ff', 600, 20)));
-- No se pudo confirmar → failed «sin confirmar» (conserva sending_at).
select finish_follow_up(pg_temp.fid('00000000-0000-0000-0000-00000000a003'), '00000000-0000-0000-0000-0000000000ee', 'failed', 'sin confirmar', null, null);
select pg_temp.expect('sin confirmar: el lead NO avanza',
  (select follow_up_step = 0 from leads where id = '00000000-0000-0000-0000-00000000a003'));
select pg_temp.expect('sin confirmar: el barrido NO lo reenvía (unconfirmed)',
  pg_temp.claim('00000000-0000-0000-0000-00000000a003', 1, '00000000-0000-0000-0000-0000000000bb') = 'unconfirmed');
select pg_temp.expect('sin confirmar: a mano sin confirmar el reenvío tampoco',
  pg_temp.claim('00000000-0000-0000-0000-00000000a003', 1, '00000000-0000-0000-0000-0000000000bb', true, false) = 'unconfirmed');
select pg_temp.expect('sin confirmar: a mano confirmando el reenvío, sí',
  pg_temp.claim('00000000-0000-0000-0000-00000000a003', 1, '00000000-0000-0000-0000-0000000000bb', true, true) = 'claimed');
-- Ese reintento falla ANTES de marcar: el último intento ya no es «sin confirmar».
select finish_follow_up(pg_temp.fid('00000000-0000-0000-0000-00000000a003'), '00000000-0000-0000-0000-0000000000bb', 'failed', 'Kommo 500', null, null);
select pg_temp.expect('tras un fallo limpio posterior, el barrido vuelve a poder reservar',
  pg_temp.claim('00000000-0000-0000-0000-00000000a003', 1, '00000000-0000-0000-0000-0000000000bb') = 'claimed');
select pg_temp.expect('se registra el envío del último paso permitido',
  finish_follow_up(pg_temp.fid('00000000-0000-0000-0000-00000000a003'), '00000000-0000-0000-0000-0000000000bb', 'sent', null, null, 1));
select pg_temp.expect('exhausted al enviar el último paso permitido',
  (select follow_up_status = 'exhausted' and follow_up_step = 1 from leads where id = '00000000-0000-0000-0000-00000000a003'));
do $$ begin
  perform finish_follow_up(gen_random_uuid(), gen_random_uuid(), 'sent', null, null, null);
  raise exception 'FALLO: sent sin p_max_follow_ups aceptado';
exception when invalid_parameter_value then raise notice 'ok: sent sin p_max_follow_ups rechazado';
end $$;

-- 8) follow_up_due_leads excluye el lead con el paso bloqueado.
update follow_up_config
   set enabled = true, business_hours = null, business_hours_start = 0, business_hours_end = 24,
       active_days = '{1,2,3,4,5,6,7}', max_follow_ups = 3, min_gap_hours = 0, run_stage_ids = '{}'
 where is_active;
delete from follow_up_steps where true;
insert into follow_up_steps (step_number, delay_hours, enabled) values (1, 1, true);
select pg_temp.expect('lead cuatro (libre) es elegible',
  exists (select 1 from follow_up_due_leads(50) where lead_id = '00000000-0000-0000-0000-00000000a004'));
select pg_temp.claim('00000000-0000-0000-0000-00000000a004', 1, '00000000-0000-0000-0000-0000000000aa');
select pg_temp.expect('con la reserva viva, lead cuatro deja de ser elegible (otro barrido no lo toma)',
  not exists (select 1 from follow_up_due_leads(50) where lead_id = '00000000-0000-0000-0000-00000000a004'));
select pg_temp.expect('lead dos (tope de interrupciones) no ocupa lugar en el barrido',
  not exists (select 1 from follow_up_due_leads(50) where lead_id = '00000000-0000-0000-0000-00000000a002'));

-- 9) RLS: el panel (authenticated) lee el log pero no lo escribe.
create temp table res (k text, ok boolean);
grant all on res to authenticated;
create or replace function pg_temp.rechaza(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when insufficient_privilege then
  return true;
end $$;
grant execute on function pg_temp.rechaza(text) to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into res select 'lee', count(*) > 0 from follow_ups;
with d as (delete from follow_ups where status = 'claimed' returning 1) insert into res select 'no borra', count(*) = 0 from d;
with u as (update follow_ups set status = 'sent' where status = 'claimed' returning 1) insert into res select 'no actualiza', count(*) = 0 from u;
insert into res values ('no inserta',
  pg_temp.rechaza($q$insert into follow_ups (lead_id, step, status) values ('00000000-0000-0000-0000-00000000a004', 2, 'sent')$q$));
reset role;
reset request.jwt.claims;
select pg_temp.expect('el panel lee follow_ups y no puede insertar, borrar ni actualizar',
  (select count(*) = 4 and bool_and(ok) from res));
select pg_temp.expect('la reserva viva de lead cuatro sigue intacta',
  pg_temp.fid('00000000-0000-0000-0000-00000000a004') is not null);

-- 10) Guard: con JWT de usuario se rechaza aunque alguien le otorgue EXECUTE.
grant execute on function claim_follow_up(uuid, int, uuid, uuid, int, boolean, boolean) to authenticated;
create temp table res2 (ok boolean);
grant all on res2 to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
insert into res2 values (pg_temp.rechaza(
  $q$select * from claim_follow_up('00000000-0000-0000-0000-00000000a004', 1, null, gen_random_uuid(), 600, true, true)$q$));
reset role;
reset request.jwt.claims;
select pg_temp.expect('el guard rechaza a un usuario con JWT en claim_follow_up', (select bool_and(ok) from res2));
revoke execute on function claim_follow_up(uuid, int, uuid, uuid, int, boolean, boolean) from authenticated;

-- 11) Permisos: solo service_role (las Edge Functions); nada para anon/authenticated.
select pg_temp.expect('RPCs de la reserva de seguimiento solo para service_role',
  has_function_privilege('service_role', 'claim_follow_up(uuid,int,uuid,uuid,int,boolean,boolean)', 'execute')
  and has_function_privilege('service_role', 'mark_follow_up_sending(uuid,uuid,text[],jsonb)', 'execute')
  and has_function_privilege('service_role', 'finish_follow_up(uuid,uuid,text,text,jsonb,int)', 'execute')
  and has_function_privilege('service_role', 'release_follow_up_claim(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'recover_dead_follow_up_claims(uuid,int,int)', 'execute')
  and has_function_privilege('service_role', 'follow_up_block_reason(uuid,int,boolean,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'claim_follow_up(uuid,int,uuid,uuid,int,boolean,boolean)', 'execute')
  and not has_function_privilege('anon', 'mark_follow_up_sending(uuid,uuid,text[],jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'finish_follow_up(uuid,uuid,text,text,jsonb,int)', 'execute')
  and not has_function_privilege('anon', 'release_follow_up_claim(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'recover_dead_follow_up_claims(uuid,int,int)', 'execute')
  and not has_function_privilege('anon', 'follow_up_block_reason(uuid,int,boolean,boolean)', 'execute')
  and not has_function_privilege('anon', 'follow_up_max_interrupted()', 'execute'));

rollback;
