-- 0088 — Un «sin respuesta a propósito» (draft `skipped`, 0087) cuenta como «sin responder».
--
-- El «sin responder» del inbox (0085) excluía todo mensaje con answered_by_draft_id: un lote
-- que el agente decidió no contestar desaparecía del indicador y el lead quedaba mudo sin que
-- nadie lo viera. Que el agente no responda (solo emojis, spam…) es una decisión que un humano
-- debe poder revisar: el lead sigue «sin responder» hasta que salga una respuesta enviada.
-- Lo mismo para un «no responder» que la compuerta de generate-response dejó en revisión
-- humana (pending, agent_metadata.no_reply = true): antes no figuraba en ningún filtro.
-- Cambia SOLO la condición de awaiting_reply en la fórmula única (inbox_summary_upsert) y
-- hace que el trigger de drafts recalcule también cuando un draft entra o sale de esos
-- estados. El resto de ambas funciones es idéntico a 0085. Además, la policy drafts_review
-- deja al panel actuar sobre un `skipped` (responder igual / marcar revisado).

create or replace function inbox_summary_upsert(p_lead_ids uuid[])
returns void language sql volatile set search_path = public, pg_temp as $$
  delete from lead_inbox_summary s
   where s.lead_id = any (p_lead_ids)
     and not exists (select 1 from messages m where m.lead_id = s.lead_id);

  insert into lead_inbox_summary as t (
    lead_id, msg_count, last_content, last_direction, last_created_at, last_vertical,
    has_review_pending, max_urgency, max_toxicity, verticals, awaiting_reply, last_reply_at, refreshed_at)
  select l.id,
         a.msg_count,
         case when r.sent_at > lm.created_at then left(r.body, 300) else lm.content end,
         case when r.sent_at > lm.created_at then 'outbound' else lm.direction end,
         greatest(lm.created_at, r.sent_at),
         lm.vertical,
         a.has_review_pending,
         a.max_urgency,
         a.max_toxicity,
         a.verticals,
         -- El lead escribió después de la última respuesta enviada, no se lo silenció a
         -- propósito y el agente no lo tomó todavía.
         coalesce(
           li.created_at is not null
           and (r.sent_at is null or li.created_at > r.sent_at)
           and not coalesce(li.ignored, false)
           and (li.answered_by_draft_id is null or li.answered_no_reply),
           false),
         r.sent_at,
         now()
    from leads l
    cross join lateral (
      select count(*)::int as msg_count,
             coalesce(max(case when m.classification->>'urgency' ~ '^-?[0-9]+(\.[0-9]+)?$'
                               then (m.classification->>'urgency')::numeric end), 0) as max_urgency,
             coalesce(max(case when m.classification->>'toxicity' ~ '^-?[0-9]+(\.[0-9]+)?$'
                               then (m.classification->>'toxicity')::numeric end), 0) as max_toxicity,
             coalesce(bool_or(m.direction = 'inbound' and m.requires_human_review), false) as has_review_pending,
             coalesce(array_agg(distinct v.slug) filter (where v.slug is not null), '{}') as verticals
        from messages m
        left join verticals v on v.id = m.vertical_id
       where m.lead_id = l.id
    ) a
    cross join lateral (
      select left(m.content, 300) as content, m.direction, m.created_at, v.slug as vertical
        from messages m
        left join verticals v on v.id = m.vertical_id
       where m.lead_id = l.id
       order by m.created_at desc, m.id
       limit 1
    ) lm
    left join lateral (
      select m.ignored, m.created_at, m.answered_by_draft_id,
             -- El lote lo «cubre» un no responder del agente (skipped, o en revisión humana
             -- con agent_metadata.no_reply): sigue sin responder hasta que salga una respuesta.
             coalesce((select d.status = 'skipped'
                              or (d.status = 'pending' and coalesce(d.agent_metadata ->> 'no_reply', '') = 'true')
                         from drafts d where d.id = m.answered_by_draft_id), false) as answered_no_reply
        from messages m
       where m.lead_id = l.id and m.direction = 'inbound'
       order by m.created_at desc, m.id
       limit 1
    ) li on true
    left join lateral (
      select d.sent_at, coalesce(nullif(btrim(d.edited_body), ''), d.body) as body
        from drafts d
        join messages m on m.id = d.message_id
       where m.lead_id = l.id and d.sent_at is not null and d.status in ('sent', 'auto_sent')
       order by d.sent_at desc, d.id
       limit 1
    ) r on true
   where l.id = any (p_lead_ids)
     and a.msg_count > 0
  on conflict (lead_id) do update set
    msg_count = excluded.msg_count,
    last_content = excluded.last_content,
    last_direction = excluded.last_direction,
    last_created_at = excluded.last_created_at,
    last_vertical = excluded.last_vertical,
    has_review_pending = excluded.has_review_pending,
    max_urgency = excluded.max_urgency,
    max_toxicity = excluded.max_toxicity,
    verticals = excluded.verticals,
    awaiting_reply = excluded.awaiting_reply,
    last_reply_at = excluded.last_reply_at,
    refreshed_at = excluded.refreshed_at;
$$;

create or replace function inbox_summary_on_drafts() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    perform inbox_summary_refresh(array(
      select m.lead_id from inbox_nuevas n join messages m on m.id = n.message_id
       where (n.sent_at is not null and n.status in ('sent', 'auto_sent')) or n.status = 'skipped'
          or coalesce(n.agent_metadata ->> 'no_reply', '') = 'true'));
  elsif tg_op = 'DELETE' then
    -- Si el borrado viene en cascada del mensaje, el mensaje ya no está: lo
    -- recalcula el trigger de messages.
    perform inbox_summary_refresh(array(
      select m.lead_id from inbox_viejas o join messages m on m.id = o.message_id
       where (o.sent_at is not null and o.status in ('sent', 'auto_sent')) or o.status = 'skipped'
          or coalesce(o.agent_metadata ->> 'no_reply', '') = 'true'));
  else
    -- EXECUTE: mismo motivo que en messages (plan según el tamaño real de las tablas).
    execute $q$
      select inbox_summary_refresh(array(
        select m.lead_id
          from inbox_viejas o
          join inbox_nuevas n on n.id = o.id
          cross join lateral (values (o.message_id), (n.message_id)) x(message_id)
          join messages m on m.id = x.message_id
         where ((o.sent_at is not null and o.status in ('sent', 'auto_sent'))
                or (n.sent_at is not null and n.status in ('sent', 'auto_sent'))
                or o.status = 'skipped' or n.status = 'skipped'
                or coalesce(o.agent_metadata ->> 'no_reply', '') = 'true'
                or coalesce(n.agent_metadata ->> 'no_reply', '') = 'true')
           and (o.message_id, o.status, o.sent_at, o.body, o.edited_body, o.agent_metadata -> 'no_reply')
               is distinct from (n.message_id, n.status, n.sent_at, n.body, n.edited_body, n.agent_metadata -> 'no_reply')))
    $q$;
  end if;
  return null;
end $$;

-- Recalcular los leads que ya tienen un «no responder» (idempotente).
select inbox_summary_refresh(array(
  select distinct m.lead_id from drafts d join messages m on m.id = d.message_id
   where d.status = 'skipped' or coalesce(d.agent_metadata ->> 'no_reply', '') = 'true'));

-- ── drafts_review (0079, initplan 0084): el panel también actúa sobre un `skipped` ─────────────
-- «Responder igual» (aprobar con texto; la ruta exige texto) o «marcar revisado»
-- (rechazar). Misma regla de alcance que 0079/0084 (claims en subconsulta escalar).
do $$
declare
  c constant text := $c$nullif(current_setting('request.jwt.claims', true), '')$c$;
  role_expr text;
  cond_operacion text;
  sub_expr text;
begin
  role_expr := format('(select %s::jsonb -> ''app_metadata'' ->> ''role'')', c);
  cond_operacion := format('coalesce(%s in (''admin'', ''configuracion'', ''editor'', ''contenido'', ''operacion''), false)', role_expr);
  sub_expr := format(
    '(select coalesce(nullif(current_setting(''request.jwt.claim.sub'', true), ''''), %s::jsonb ->> ''sub'')::uuid)', c);
  drop policy if exists drafts_review on drafts;
  execute format(
    'create policy drafts_review on drafts for update to authenticated '
    'using (%s and status in (''pending'', ''approved'', ''skipped'')) '
    'with check (%s and status in (''approved'', ''rejected'') and reviewer_id = %s)',
    cond_operacion, cond_operacion, sub_expr);
end $$;
