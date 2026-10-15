-- Prueba de la reserva por draft al publicar (migración 0074) contra un Postgres con
-- TODAS las migraciones aplicadas (descartable: borra drafts/messages/leads dentro de
-- la transacción, que termina en rollback):
--   · claim_draft_for_publish (de dos reservas del mismo draft gana una; orden; publish_from),
--   · mark_draft_publish_sending (solo el dueño y con el lease vigente),
--   · recover_dead_draft_publishes (requeued / gave_up / resolve; nunca reenvía lo marcado),
--   · CHECK de estados y de lease, trigger drafts_guard_in_flight (el panel no toca
--     un draft `publishing` ni des-envía uno enviado) y permisos.
--
--   sed 's#${SUPABASE_URL}#http://x.test#g' supabase/migrations/*.sql | psql ...   (una vez)
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/draft_publish_claim.sql
--
-- La carrera REAL entre dos sesiones (for update skip locked) se prueba aparte con dos
-- conexiones; acá se prueba la guarda de estado que la hace segura.
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- Usuarios reales (las columnas *_by / reviewer_id tienen FK a auth.users): así un rechazo es de
-- la policy, no de la FK.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'zz-uno@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'zz-dos@test.local')
  on conflict (id) do nothing;

delete from drafts where true;
delete from messages where true;
delete from leads where true;

insert into leads (id, kommo_lead_id, display_name) values ('00000000-0000-0000-0000-00000000a001', 9001, 'Lead prueba');
insert into messages (id, lead_id, direction, content) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000a001', 'inbound', 'hola');
insert into drafts (id, message_id, body, status, created_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000b001', 'uno', 'approved', now() - interval '3 minutes'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-00000000b001', 'dos', 'approved', now() - interval '2 minutes'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-00000000b001', 'tres', 'pending', now() - interval '1 minute');

-- 1) Reserva: el más viejo primero; una segunda reserva NO recibe el mismo draft.
select pg_temp.expect('el cron reserva el draft approved más viejo',
  claim_draft_for_publish('00000000-0000-0000-0000-0000000000aa', 600, null) = '00000000-0000-0000-0000-0000000000d1');
select pg_temp.expect('la reserva del panel (otro dueño) recibe OTRO draft, nunca el ya reservado',
  claim_draft_for_publish('00000000-0000-0000-0000-0000000000bb', 600, null) = '00000000-0000-0000-0000-0000000000d2');
select pg_temp.expect('sin más approved: null (el pending no se toca)',
  claim_draft_for_publish('00000000-0000-0000-0000-0000000000cc', 600, null) is null);
select pg_temp.expect('d1 queda publishing con dueño, lease ~10 min y 1 intento',
  (select status = 'publishing' and publish_owner = '00000000-0000-0000-0000-0000000000aa'
          and publish_lease_until between now() + interval '590 seconds' and now() + interval '610 seconds'
          and publish_attempts = 1 and publish_sending_at is null
     from drafts where id = '00000000-0000-0000-0000-0000000000d1'));
select pg_temp.expect('d3 sigue pending', (select status = 'pending' from drafts where id = '00000000-0000-0000-0000-0000000000d3'));

-- 2) El MISMO draft reservado dos veces: solo una gana.
update drafts set status = 'approved', publish_owner = null, publish_lease_until = null
 where id = '00000000-0000-0000-0000-0000000000d2';
update drafts set status = 'rejected', publish_owner = null, publish_lease_until = null
 where id = '00000000-0000-0000-0000-0000000000d1';
create temp table carrera as
  select claim_draft_for_publish('00000000-0000-0000-0000-0000000000aa', 600, null) as cron,
         null::uuid as manual;
update carrera set manual = claim_draft_for_publish('00000000-0000-0000-0000-0000000000bb', 600, null);
select pg_temp.expect('carrera cron vs. manual sobre d2: gana una sola reserva',
  (select cron = '00000000-0000-0000-0000-0000000000d2' and manual is null from carrera));

-- 3) publish_from: un draft anterior al go-live no se reserva.
update drafts set status = 'approved', publish_owner = null, publish_lease_until = null
 where id = '00000000-0000-0000-0000-0000000000d2';
select pg_temp.expect('publish_from posterior al draft: no se reserva',
  claim_draft_for_publish('00000000-0000-0000-0000-0000000000aa', 600, now()) is null);
do $$ begin
  perform claim_draft_for_publish('00000000-0000-0000-0000-0000000000aa', 0, null);
  raise exception 'FALLO: lease 0 aceptado';
exception when invalid_parameter_value then raise notice 'ok: lease 0 rechazado';
end $$;

-- 4) Marca write-ahead: solo el dueño, con el lease vigente; la segunda llamada solo actualiza la foto.
select claim_draft_for_publish('00000000-0000-0000-0000-0000000000aa', 600, null);
select pg_temp.expect('otro dueño no puede marcar el envío',
  mark_draft_publish_sending('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000bb', null) = false);
select pg_temp.expect('el dueño marca el envío (respuesta pública, sin foto)',
  mark_draft_publish_sending('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000aa', null) = true);
update drafts set publish_sending_at = publish_sending_at - interval '5 seconds' where id = '00000000-0000-0000-0000-0000000000d2';
create temp table marca as select publish_sending_at as t from drafts where id = '00000000-0000-0000-0000-0000000000d2';
select pg_temp.expect('segunda marca (DM) aceptada',
  mark_draft_publish_sending('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000aa', array['e1', 'e2']) = true);
select pg_temp.expect('la segunda marca guarda la foto y conserva el instante de la primera',
  (select publish_baseline = array['e1', 'e2'] and publish_sending_at = (select t from marca)
     from drafts where id = '00000000-0000-0000-0000-0000000000d2'));
update drafts set publish_lease_until = now() - interval '1 second' where id = '00000000-0000-0000-0000-0000000000d2';
select pg_temp.expect('con el lease vencido el dueño YA NO puede marcar (no envía)',
  mark_draft_publish_sending('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000aa', null) = false);

-- 5) Recuperación de reservas muertas.
--    d2: vencido y CON marca → resolve (nunca vuelve a approved).
--    d4: vencido SIN marca → requeued.  d5: vencido sin marca y 3 intentos → gave_up.
--    d6: publishing con lease vigente → no se toca.
insert into drafts (id, message_id, body, status, publish_owner, publish_lease_until, publish_attempts, created_at) values
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-00000000b001', 'cuatro', 'publishing',
     '00000000-0000-0000-0000-0000000000aa', now() - interval '1 minute', 1, now()),
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-00000000b001', 'cinco', 'publishing',
     '00000000-0000-0000-0000-0000000000aa', now() - interval '1 minute', 3, now()),
  ('00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-00000000b001', 'seis', 'publishing',
     '00000000-0000-0000-0000-0000000000aa', now() + interval '5 minutes', 1, now());
create temp table rec as
  select * from recover_dead_draft_publishes('00000000-0000-0000-0000-0000000000ee', 600, 20, 3);
select pg_temp.expect('recover devuelve exactamente requeued d4, gave_up d5, resolve d2',
  (select array_agg(draft_id::text || ':' || action order by action) from rec)
  = array['00000000-0000-0000-0000-0000000000d5:gave_up',
          '00000000-0000-0000-0000-0000000000d4:requeued',
          '00000000-0000-0000-0000-0000000000d2:resolve']);
select pg_temp.expect('d4 (murió antes de enviar) vuelve a approved sin dueño',
  (select status = 'approved' and publish_owner is null and publish_lease_until is null
     from drafts where id = '00000000-0000-0000-0000-0000000000d4'));
select pg_temp.expect('d5 (3 reservas muertas) queda failed con el motivo, sin dueño',
  (select status = 'failed' and publish_owner is null and agent_metadata ? 'publish_error'
          and (agent_metadata ->> 'publish_interrupted')::boolean
     from drafts where id = '00000000-0000-0000-0000-0000000000d5'));
select pg_temp.expect('d2 (con marca) NO vuelve a approved: sigue publishing, retomado por el resolvedor con lease nuevo',
  (select status = 'publishing' and publish_owner = '00000000-0000-0000-0000-0000000000ee'
          and publish_lease_until > now() and publish_baseline = array['e1', 'e2']
     from drafts where id = '00000000-0000-0000-0000-0000000000d2'));
select pg_temp.expect('d6 (lease vigente) intacto',
  (select status = 'publishing' and publish_owner = '00000000-0000-0000-0000-0000000000aa'
     from drafts where id = '00000000-0000-0000-0000-0000000000d6'));
select pg_temp.expect('segunda pasada inmediata: nada que recuperar (el resolvedor tiene lease vigente)',
  (select count(*) = 0 from recover_dead_draft_publishes('00000000-0000-0000-0000-0000000000ff', 600, 20, 3)));
select pg_temp.expect('d4 reencolado se puede reservar de nuevo',
  claim_draft_for_publish('00000000-0000-0000-0000-0000000000aa', 600, null) = '00000000-0000-0000-0000-0000000000d4');
select pg_temp.expect('la nueva reserva de d4 cuenta el intento 2 y arranca sin marca',
  (select publish_attempts = 2 and publish_sending_at is null from drafts where id = '00000000-0000-0000-0000-0000000000d4'));

-- 6) CHECKs: `publishing` es un estado válido y siempre lleva dueño + lease.
do $$ begin
  update drafts set publish_owner = null where id = '00000000-0000-0000-0000-0000000000d6';
  raise exception 'FALLO: publishing sin dueño aceptado';
exception when check_violation then raise notice 'ok: publishing sin dueño rechazado';
end $$;
do $$ begin
  update drafts set status = 'enviando' where id = '00000000-0000-0000-0000-0000000000d3';
  raise exception 'FALLO: estado desconocido aceptado';
exception when check_violation then raise notice 'ok: estado desconocido rechazado';
end $$;

-- 7) El panel (petición con JWT de usuario) no toca un draft en vuelo ni des-envía uno enviado.
update drafts set status = 'auto_sent', sent_at = now(), publish_owner = null, publish_lease_until = null
 where id = '00000000-0000-0000-0000-0000000000d5';
-- Dos capas: (a) la RLS (0079) solo deja al panel tocar drafts pending/approved, y solo hacia
-- approved/rejected a nombre propio; (b) el trigger drafts_guard_in_flight (0074) frena igual
-- cualquier petición con JWT de usuario aunque alguien abriera la RLS (se prueba como dueño,
-- que bypasea la RLS, con claims de usuario).
create or replace function pg_temp.filas(p_sql text) returns int language plpgsql as $$
declare v_n int;
begin
  execute p_sql;
  get diagnostics v_n = row_count;
  return v_n;
exception when others then
  return -1;
end $$;
create or replace function pg_temp.bloquea(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when object_not_in_prerequisite_state then
  return true;
end $$;
grant execute on function pg_temp.filas(text) to authenticated;
create temp table res (k text, n int);
grant all on res to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"operacion"}}';
insert into res values ('aprobar publishing',
  pg_temp.filas($q$update drafts set status = 'approved', reviewer_id = '11111111-1111-1111-1111-111111111111' where id = '00000000-0000-0000-0000-0000000000d6'$q$));
insert into res values ('editar publishing',
  pg_temp.filas($q$update drafts set edited_body = 'otro' where id = '00000000-0000-0000-0000-0000000000d6'$q$));
insert into res values ('rechazar publishing',
  pg_temp.filas($q$update drafts set status = 'rejected', reviewer_id = '11111111-1111-1111-1111-111111111111' where id = '00000000-0000-0000-0000-0000000000d6'$q$));
insert into res values ('re-aprobar auto_sent',
  pg_temp.filas($q$update drafts set status = 'approved', reviewer_id = '11111111-1111-1111-1111-111111111111' where id = '00000000-0000-0000-0000-0000000000d5'$q$));
insert into res values ('aprobar pending',
  pg_temp.filas($q$update drafts set status = 'approved', reviewer_id = '11111111-1111-1111-1111-111111111111' where id = '00000000-0000-0000-0000-0000000000d3'$q$));
reset role;
reset request.jwt.claims;
select pg_temp.expect('RLS: el panel no toca un draft publishing ni auto_sent (0 filas) y sí aprueba un pending',
  (select bool_and(n = 0) from res where k <> 'aprobar pending')
  and (select n = 1 from res where k = 'aprobar pending'));

-- (b) trigger: como dueño (bypasea la RLS) pero con claims de usuario.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select pg_temp.expect('trigger: una petición con JWT de usuario no aprueba, edita ni rechaza un publishing ni re-aprueba un auto_sent',
  pg_temp.bloquea($q$update drafts set status = 'approved' where id = '00000000-0000-0000-0000-0000000000d6'$q$)
  and pg_temp.bloquea($q$update drafts set edited_body = 'otro' where id = '00000000-0000-0000-0000-0000000000d6'$q$)
  and pg_temp.bloquea($q$update drafts set status = 'rejected' where id = '00000000-0000-0000-0000-0000000000d6'$q$)
  and pg_temp.bloquea($q$update drafts set status = 'approved' where id = '00000000-0000-0000-0000-0000000000d5'$q$));
reset request.jwt.claims;
select pg_temp.expect('d6 sigue publishing tras los intentos del panel',
  (select status = 'publishing' and edited_body is null from drafts where id = '00000000-0000-0000-0000-0000000000d6'));
update drafts set status = 'auto_sent', sent_at = now(), publish_owner = null, publish_lease_until = null
 where id = '00000000-0000-0000-0000-0000000000d6' and status = 'publishing'
   and publish_owner = '00000000-0000-0000-0000-0000000000aa';
select pg_temp.expect('el worker (sin JWT) sí cierra su reserva',
  (select status = 'auto_sent' from drafts where id = '00000000-0000-0000-0000-0000000000d6'));

-- 8) Permisos: solo service_role (las Edge Functions); nada para anon/authenticated.
select pg_temp.expect('RPCs de reserva solo para service_role',
  has_function_privilege('service_role', 'claim_draft_for_publish(uuid,int,timestamptz)', 'execute')
  and has_function_privilege('service_role', 'mark_draft_publish_sending(uuid,uuid,text[])', 'execute')
  and has_function_privilege('service_role', 'recover_dead_draft_publishes(uuid,int,int,int)', 'execute')
  and not has_function_privilege('authenticated', 'claim_draft_for_publish(uuid,int,timestamptz)', 'execute')
  and not has_function_privilege('anon', 'mark_draft_publish_sending(uuid,uuid,text[])', 'execute')
  and not has_function_privilege('authenticated', 'recover_dead_draft_publishes(uuid,int,int,int)', 'execute')
  and not has_function_privilege('anon', 'drafts_guard_in_flight()', 'execute'));

rollback;
