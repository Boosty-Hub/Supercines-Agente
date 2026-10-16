-- «Sin respuesta a propósito» (draft skipped, 0087/0088) cuenta como «sin responder» en el inbox.
-- Un skip no puede dejar al lead mudo en silencio: queda visible y en el indicador hasta que
-- salga una respuesta enviada. psql -v ON_ERROR_STOP=1 -f supabase/tests/inbox_skipped.sql
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

insert into leads (id, kommo_lead_id, display_name, channel)
  values ('00000000-0000-0000-0000-00000000a081', 908101, 'Lead skip', 'instagram');
insert into messages (id, lead_id, direction, content, created_at)
  values ('10000000-0000-0000-0000-00000000a081', '00000000-0000-0000-0000-00000000a081', 'inbound', '😂😂😂', now() - interval '5 minutes');
select pg_temp.expect('inbound nuevo → sin responder',
  (select awaiting_reply from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-00000000a081'));

-- generate-response: crea el draft pending y reclama el lote (answered_by_draft_id).
insert into drafts (id, message_id, body, status)
  values ('20000000-0000-0000-0000-00000000a081', '10000000-0000-0000-0000-00000000a081', '', 'pending');
update messages set answered_by_draft_id = '20000000-0000-0000-0000-00000000a081'
 where id = '10000000-0000-0000-0000-00000000a081';
select pg_temp.expect('lote tomado por el agente (generando) → no figura sin responder',
  (select not awaiting_reply from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-00000000a081'));

update drafts set status = 'skipped' where id = '20000000-0000-0000-0000-00000000a081';
select pg_temp.expect('el agente decidió no responder (skipped) → vuelve a sin responder',
  (select awaiting_reply and last_reply_at is null from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-00000000a081'));
select pg_temp.expect('el filtro «sin responder» del inbox lo incluye',
  inbox_page(null, null, '{"estado": "waiting"}'::jsonb, 'recent', null, 500)::text
    like '%00000000-0000-0000-0000-00000000a081%');

-- Un «no responder» que la compuerta dejó en revisión (pending + no_reply) también figura.
update drafts set status = 'pending', agent_metadata = '{"no_reply": true, "no_reply_review": "x"}'
 where id = '20000000-0000-0000-0000-00000000a081';
select pg_temp.expect('no responder en revisión (pending + no_reply) → sin responder',
  (select awaiting_reply from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-00000000a081'));
update drafts set agent_metadata = '{}' where id = '20000000-0000-0000-0000-00000000a081';
select pg_temp.expect('pending común (generando) → no figura sin responder',
  (select not awaiting_reply from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-00000000a081'));
update drafts set status = 'skipped', agent_metadata = '{"no_reply": true}' where id = '20000000-0000-0000-0000-00000000a081';

-- El panel (operacion) puede «marcar revisado» un skipped; un sin rol no.
insert into auth.users (id, email, raw_app_meta_data) values
  ('30000000-0000-0000-0000-00000000a081', 'op-a081@test.local', '{"role": "operacion"}');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "30000000-0000-0000-0000-00000000a081", "app_metadata": {"role": "operacion"}}', true);
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-00000000a081', true);
with u as (update drafts set status = 'rejected', reviewer_id = '30000000-0000-0000-0000-00000000a081'
            where id = '20000000-0000-0000-0000-00000000a081' returning 1)
select pg_temp.expect('operacion marca revisado un skipped', (select count(*) = 1 from u));
reset role;
update drafts set status = 'skipped', reviewer_id = null where id = '20000000-0000-0000-0000-00000000a081';

-- Un humano responde (draft enviado posterior) → deja de estar sin responder.
insert into messages (id, lead_id, direction, content, created_at)
  values ('10000000-0000-0000-0000-00000000a082', '00000000-0000-0000-0000-00000000a081', 'inbound', 'hola?', now() - interval '2 minutes');
insert into drafts (id, message_id, body, status, sent_at)
  values ('20000000-0000-0000-0000-00000000a082', '10000000-0000-0000-0000-00000000a082', 'Hola!', 'sent', now());
update messages set answered_by_draft_id = '20000000-0000-0000-0000-00000000a082'
 where id = '10000000-0000-0000-0000-00000000a082';
select pg_temp.expect('respuesta enviada → ya no sin responder',
  (select not awaiting_reply and last_reply_at is not null from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-00000000a081'));

-- El resumen guardado coincide con la fórmula recalculada desde cero.
create temp table snap as select lead_id, awaiting_reply, last_reply_at from lead_inbox_summary
 where lead_id = '00000000-0000-0000-0000-00000000a081';
select inbox_summary_upsert(array['00000000-0000-0000-0000-00000000a081'::uuid]);
select pg_temp.expect('resumen = fórmula',
  (select (s.awaiting_reply, s.last_reply_at) is not distinct from (t.awaiting_reply, t.last_reply_at)
     from snap s join lead_inbox_summary t using (lead_id)));

rollback;
