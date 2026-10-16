-- 0089: un draft sin texto no llega a approved/publishing/sent/auto_sent, ni por PostgREST
-- con la sesión del panel ni con service_role. psql -v ON_ERROR_STOP=1 -f supabase/tests/drafts_texto_para_enviar.sql
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

create or replace function pg_temp.falla_check(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when check_violation then
  return true;
end $$;

insert into leads (id, kommo_lead_id, display_name) values ('00000000-0000-0000-0000-00000000b082', 908201, 'Lead texto');
insert into messages (id, lead_id, direction, content)
  values ('10000000-0000-0000-0000-00000000b082', '00000000-0000-0000-0000-00000000b082', 'inbound', '😂');
insert into drafts (id, message_id, body, status, agent_metadata)
  values ('20000000-0000-0000-0000-00000000b082', '10000000-0000-0000-0000-00000000b082', '', 'skipped', '{"no_reply": true}');

select pg_temp.expect('skipped/pending sin texto: permitido (es el estado del no responder)',
  not pg_temp.falla_check($q$update drafts set status = 'pending' where id = '20000000-0000-0000-0000-00000000b082'$q$));
select pg_temp.expect('approved sin texto: rechazado',
  pg_temp.falla_check($q$update drafts set status = 'approved' where id = '20000000-0000-0000-0000-00000000b082'$q$));
select pg_temp.expect('approved con edited_body de solo espacios: rechazado',
  pg_temp.falla_check($q$update drafts set status = 'approved', edited_body = '   ' where id = '20000000-0000-0000-0000-00000000b082'$q$));
select pg_temp.expect('auto_sent sin texto: rechazado',
  pg_temp.falla_check($q$update drafts set status = 'auto_sent', sent_at = now() where id = '20000000-0000-0000-0000-00000000b082'$q$));
select pg_temp.expect('approved con body de solo espacios Unicode (como trim() de JS): rechazado',
  pg_temp.falla_check($q$update drafts set status = 'approved', edited_body = null, body = E'\n\t\u00a0\u3000\ufeff' where id = '20000000-0000-0000-0000-00000000b082'$q$));
select pg_temp.expect('U+0085 / U+001C no son espacio para trim() de JS: un body así NO es vacío (paridad)',
  not pg_temp.falla_check($q$update drafts set status = 'approved', edited_body = null, body = E'\u0085\u001c' where id = '20000000-0000-0000-0000-00000000b082'$q$));
update drafts set status = 'skipped' where id = '20000000-0000-0000-0000-00000000b082';
update drafts set body = '' where id = '20000000-0000-0000-0000-00000000b082';
select pg_temp.expect('approved con edited_body («responder igual»): permitido',
  not pg_temp.falla_check($q$update drafts set status = 'approved', edited_body = 'Hola!' where id = '20000000-0000-0000-0000-00000000b082'$q$));

-- Saneo de la migración: un approved/publishing viejo sin texto vuelve a revisión (si no,
-- trabaría la cola de publicación al reservarlo).
update drafts set status = 'skipped', edited_body = null where id = '20000000-0000-0000-0000-00000000b082';
alter table drafts drop constraint drafts_texto_para_enviar;
update drafts set status = 'approved' where id = '20000000-0000-0000-0000-00000000b082';
\ir ../migrations/0089_drafts_texto_para_enviar.sql
select pg_temp.expect('el saneo devuelve a pending (guard texto vacío) el approved sin texto y la restricción queda validada',
  (select status = 'pending' and agent_metadata ->> 'guard_reason' = 'texto vacío' from drafts where id = '20000000-0000-0000-0000-00000000b082')
  and (select convalidated from pg_constraint where conname = 'drafts_texto_para_enviar'));

-- Con la sesión del panel (operacion) por PostgREST directo: tampoco.
update drafts set status = 'skipped', edited_body = null where id = '20000000-0000-0000-0000-00000000b082';
insert into auth.users (id, email, raw_app_meta_data) values
  ('30000000-0000-0000-0000-00000000b082', 'op-b082@test.local', '{"role": "operacion"}');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "30000000-0000-0000-0000-00000000b082", "app_metadata": {"role": "operacion"}}', true);
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-00000000b082', true);
select pg_temp.expect('operacion no puede aprobar un skipped sin texto saltando la ruta',
  pg_temp.falla_check($q$update drafts set status = 'approved', reviewer_id = '30000000-0000-0000-0000-00000000b082'
                         where id = '20000000-0000-0000-0000-00000000b082'$q$));
reset role;

rollback;
