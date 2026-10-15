-- =============================================================
-- 0085_inbox_paginado.sql
-- Inbox paginado y filtrado EN LA BASE: el costo de abrir el tablero/la lista ya
-- no crece con la cantidad de leads.
--
-- Antes: inbox_lead_summaries() (0061) calculaba el resumen de TODOS los leads
-- (agregado sobre toda la tabla de mensajes) y /api/inbox/leads lo pedía de a
-- 1000 filas; cada página recalculaba la función entera. Con 16k leads eran 17
-- páginas de ~1,3 s: 27–31 s para abrir el inbox, y el filtrado/orden se hacía
-- en el navegador sobre las 16k filas.
--
-- Ahora:
--
-- 1) lead_inbox_summary: el resumen por lead (último mensaje, conteos,
--    máximos, revisión pendiente, «sin responder», última respuesta) GUARDADO,
--    una fila por lead con al menos un mensaje. Lo mantienen triggers de
--    sentencia sobre messages, drafts y verticals que recalculan SOLO los leads
--    tocados (inbox_summary_refresh). La definición del resumen vive en UN solo
--    lugar (inbox_summary_upsert): el trigger y el backfill usan la misma, así
--    que la tabla no puede divergir de la fórmula. Concurrencia: el refresco
--    toma un lock advisory POR LEAD (en orden de id) antes de recalcular, y cada
--    sentencia de la función ve una foto nueva: dos escrituras concurrentes del
--    mismo lead se serializan y la última ve todo lo confirmado. Advisory y no el
--    lock de fila de leads: así el refresco no entra en el orden de locks de
--    quienes actualizan leads (mark_kommo_leads_missing, PATCH masivos), y no hay
--    ciclos de deadlock con ellos.
--
-- 2) inbox_page(): una «rebanada» de leads (todas, un pipeline, una etapa, la
--    columna «Etapa desconocida», «Sin pipeline» o «No existe en Kommo») con los
--    filtros del inbox aplicados en SQL, ordenada y paginada por KEYSET (cursor =
--    claves de orden del último lead, nunca OFFSET). Calcula solo lo pedido.
--
-- 3) inbox_board(): el tablero de un pipeline en UNA llamada: por columna, las
--    primeras N tarjetas + el total (conteo agregado con los mismos filtros).
--
-- 4) inbox_stats(): números del encabezado y de las pestañas de pipeline (con y
--    sin filtros) + las opciones de los filtros (canales y verticales).
--
-- 5) Índices de keyset sobre leads (pipeline, etapa, última actividad, id) y
--    (última actividad, id). La «última actividad» es
--    coalesce(last_message_at, '-infinity'): una clave total, sin NULL, que
--    permite comparar filas en el índice.
--
-- Los filtros llegan como jsonb (p_filters) y los traduce a SQL UNA función
-- (inbox_filter_sql): sumar un filtro es tocar solo esa función. Todo valor entra
-- como literal con format('%L') (sin inyección).
--
-- Propio de SuperCines: las pestañas de la LISTA «Con agente» / «Apagadas» / «Todas»
-- (el agente responde la etapa del lead: sin etapa o etapa fuera de
-- kommo_publish_config.ignored_stage_ids = «con agente», fail-open como el gate de
-- process-inbound) son el filtro `etapa`; inbox_stats devuelve sus conteos con los demás
-- filtros aplicados y el «sin responder» del inbox completo (awaiting_all). El tablero
-- no aplica la pestaña: es el espejo completo de Kommo.
--
-- SECURITY INVOKER (la RLS aplica con la sesión del usuario: lead_inbox_summary
-- tiene la misma regla de lectura que leads/messages, operacion+). Los triggers
-- son SECURITY DEFINER porque el panel actualiza messages/drafts con la sesión
-- (revisión humana, aprobar) y la sesión no escribe lead_inbox_summary; una
-- función de trigger no se puede invocar por RPC.
--
-- Reemplaza a inbox_lead_summaries() (se borra: nadie la usa).
-- IDEMPOTENTE.
-- =============================================================

-- ── 1) Tabla del resumen ─────────────────────────────────────────────────────
create table if not exists lead_inbox_summary (
  lead_id            uuid primary key references leads(id) on delete cascade,
  msg_count          int not null,
  last_content       text,
  last_direction     text,
  last_created_at    timestamptz,
  last_vertical      text,
  has_review_pending boolean not null default false,
  max_urgency        numeric not null default 0,
  max_toxicity       numeric not null default 0,
  verticals          text[] not null default '{}',
  awaiting_reply     boolean not null default false,
  last_reply_at      timestamptz,
  refreshed_at       timestamptz not null default now()
);

comment on table lead_inbox_summary is
  'Resumen del inbox por lead (0085). Lo escriben SOLO los triggers de messages/drafts/verticals vía inbox_summary_refresh(); la fórmula está en inbox_summary_upsert().';

alter table lead_inbox_summary enable row level security;
revoke all on lead_inbox_summary from anon, authenticated, public;
grant all on lead_inbox_summary to service_role;
grant select on lead_inbox_summary to authenticated;
drop policy if exists lead_inbox_summary_read on lead_inbox_summary;
-- Misma regla que leads/messages (0079): operacion+, claims en subconsulta escalar (InitPlan).
create policy lead_inbox_summary_read on lead_inbox_summary for select to authenticated
  using (coalesce((select nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'role')
                  in ('admin', 'configuracion', 'editor', 'contenido', 'operacion'), false));

-- ── 2) La fórmula del resumen (única) ────────────────────────────────────────
-- Recalcula los leads pedidos: borra el resumen de los que ya no tienen mensajes
-- y hace upsert del resto. NO toma locks (lo hace inbox_summary_refresh); el
-- backfill de abajo la llama directo con la escritura de messages/drafts ya
-- bloqueada por la creación de los triggers.
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
           and li.answered_by_draft_id is null,
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
      select m.ignored, m.created_at, m.answered_by_draft_id
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

-- Refresco serializado por lead. Locks advisory de transacción:
--   · por lead, en orden de id (dos refrescos de varios leads no se cruzan), bajo el
--     lock GLOBAL en modo compartido;
--   · una sentencia que toca más de 100 leads toma SOLO el global en modo
--     exclusivo (un lock por lead agotaría la tabla de locks de la instancia).
-- La segunda escritura del mismo lead espera a que la primera confirme y, al ser una
-- sentencia nueva, ve sus cambios.
create or replace function inbox_summary_refresh(p_lead_ids uuid[])
returns void language plpgsql volatile set search_path = public, pg_temp as $$
declare
  v_ids uuid[];
  v_id uuid;
begin
  select array_agg(x order by x) into v_ids
    from (select distinct x from unnest(p_lead_ids) x where x is not null) d;
  if v_ids is null then
    return;
  end if;
  if cardinality(v_ids) > 100 then
    perform pg_advisory_xact_lock(hashtextextended('inbox_summary:*', 79));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('inbox_summary:*', 79));
    foreach v_id in array v_ids loop
      perform pg_advisory_xact_lock(hashtextextended('inbox_summary:' || v_id::text, 79));
    end loop;
  end if;
  perform inbox_summary_upsert(v_ids);
end $$;

-- ── 3) Triggers (de sentencia, con tablas de transición) ─────────────────────
-- Un trigger con tablas de transición admite UN solo evento: uno por evento.
create or replace function inbox_summary_on_messages() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    perform inbox_summary_refresh(array(select n.lead_id from inbox_nuevas n));
  elsif tg_op = 'DELETE' then
    perform inbox_summary_refresh(array(select o.lead_id from inbox_viejas o));
  else
    -- Solo si cambió algo que el resumen lee (las columnas de proceso, como
    -- media_* o la clasificación en curso, cambian seguido y no lo tocan).
    -- EXECUTE (plan nuevo en cada disparo): un plan cacheado con tablas de transición
    -- de 1 fila elegía un nested loop y un UPDATE de miles de filas tardaba segundos.
    execute $q$
      select inbox_summary_refresh(array(
        select x.lead_id
          from inbox_viejas o
          join inbox_nuevas n on n.id = o.id
          cross join lateral (values (o.lead_id), (n.lead_id)) x(lead_id)
         where (o.lead_id, o.direction, o.content, o.created_at, o.vertical_id, o.classification,
                o.requires_human_review, o.ignored, o.answered_by_draft_id)
               is distinct from
               (n.lead_id, n.direction, n.content, n.created_at, n.vertical_id, n.classification,
                n.requires_human_review, n.ignored, n.answered_by_draft_id)))
    $q$;
  end if;
  return null;
end $$;

-- Un draft solo cuenta para el resumen si está (o estuvo) ENVIADO: la última
-- respuesta y el «sin responder» salen de drafts sent/auto_sent con sent_at.
create or replace function inbox_summary_on_drafts() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    perform inbox_summary_refresh(array(
      select m.lead_id from inbox_nuevas n join messages m on m.id = n.message_id
       where n.sent_at is not null and n.status in ('sent', 'auto_sent')));
  elsif tg_op = 'DELETE' then
    -- Si el borrado viene en cascada del mensaje, el mensaje ya no está: lo
    -- recalcula el trigger de messages.
    perform inbox_summary_refresh(array(
      select m.lead_id from inbox_viejas o join messages m on m.id = o.message_id
       where o.sent_at is not null and o.status in ('sent', 'auto_sent')));
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
                or (n.sent_at is not null and n.status in ('sent', 'auto_sent')))
           and (o.message_id, o.status, o.sent_at, o.body, o.edited_body)
               is distinct from (n.message_id, n.status, n.sent_at, n.body, n.edited_body)))
    $q$;
  end if;
  return null;
end $$;

-- TRUNCATE no tiene filas de transición: se recalcula el resumen entero (con
-- messages vacía, la fórmula borra todas las filas). drafts y messages se referencian
-- entre sí, así que en la práctica un TRUNCATE de una arrastra a la otra (cascade).
create or replace function inbox_summary_on_truncate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform inbox_summary_refresh(array(select lead_id from lead_inbox_summary));
  return null;
end $$;

-- Renombrar una vertical cambia el slug que el resumen guarda (toca a todos los
-- leads con mensajes de esa vertical en una sentencia: hacerlo fuera de horario).
create or replace function inbox_summary_on_verticals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  execute $q$
    select inbox_summary_refresh(array(
      select distinct m.lead_id
        from inbox_viejas o
        join inbox_nuevas n on n.id = o.id
        join messages m on m.vertical_id = n.id
       where o.slug is distinct from n.slug))
  $q$;
  return null;
end $$;

revoke execute on function inbox_summary_upsert(uuid[]), inbox_summary_refresh(uuid[]),
  inbox_summary_on_messages(), inbox_summary_on_drafts(), inbox_summary_on_verticals(),
  inbox_summary_on_truncate()
  from public, anon, authenticated;
grant execute on function inbox_summary_upsert(uuid[]), inbox_summary_refresh(uuid[]) to service_role;

-- Los triggers se crean ANTES del backfill: crearlos toma un lock que frena las
-- escrituras de messages/drafts hasta el commit de la migración, así ninguna
-- escritura concurrente queda fuera del resumen (ni del backfill ni del trigger).
drop trigger if exists inbox_summary_messages_ins on messages;
create trigger inbox_summary_messages_ins after insert on messages
  referencing new table as inbox_nuevas
  for each statement execute function inbox_summary_on_messages();
drop trigger if exists inbox_summary_messages_upd on messages;
create trigger inbox_summary_messages_upd after update on messages
  referencing old table as inbox_viejas new table as inbox_nuevas
  for each statement execute function inbox_summary_on_messages();
drop trigger if exists inbox_summary_messages_del on messages;
create trigger inbox_summary_messages_del after delete on messages
  referencing old table as inbox_viejas
  for each statement execute function inbox_summary_on_messages();

drop trigger if exists inbox_summary_drafts_ins on drafts;
create trigger inbox_summary_drafts_ins after insert on drafts
  referencing new table as inbox_nuevas
  for each statement execute function inbox_summary_on_drafts();
drop trigger if exists inbox_summary_drafts_upd on drafts;
create trigger inbox_summary_drafts_upd after update on drafts
  referencing old table as inbox_viejas new table as inbox_nuevas
  for each statement execute function inbox_summary_on_drafts();
drop trigger if exists inbox_summary_drafts_del on drafts;
create trigger inbox_summary_drafts_del after delete on drafts
  referencing old table as inbox_viejas
  for each statement execute function inbox_summary_on_drafts();

drop trigger if exists inbox_summary_messages_trunc on messages;
create trigger inbox_summary_messages_trunc after truncate on messages
  for each statement execute function inbox_summary_on_truncate();
drop trigger if exists inbox_summary_drafts_trunc on drafts;
create trigger inbox_summary_drafts_trunc after truncate on drafts
  for each statement execute function inbox_summary_on_truncate();

drop trigger if exists inbox_summary_verticals_upd on verticals;
create trigger inbox_summary_verticals_upd after update on verticals
  referencing old table as inbox_viejas new table as inbox_nuevas
  for each statement execute function inbox_summary_on_verticals();

-- Backfill (y re-sincronización si la migración se vuelve a aplicar).
do $$ begin perform inbox_summary_upsert(array(select id from leads)); end $$;

-- ── 4) Índices de keyset ─────────────────────────────────────────────────────
-- Columna del tablero: pipeline + etapa, en orden de última actividad. Reemplaza
-- a leads_pipeline_stage_idx (0061), que ordenaba por last_message_at con NULLs y
-- no servía para comparar el cursor como fila.
create index if not exists leads_inbox_stage_idx
  on leads (kommo_pipeline_id, kommo_stage_id, (coalesce(last_message_at, '-infinity'::timestamptz)) desc, id desc);
drop index if exists leads_pipeline_stage_idx;
-- Vista Lista (todos los leads).
create index if not exists leads_inbox_recent_idx
  on leads ((coalesce(last_message_at, '-infinity'::timestamptz)) desc, id desc);

-- ── 5) Filtros → SQL ─────────────────────────────────────────────────────────
-- p_filters: { q, channel, vertical, estado, urgent, rango, etapa } (las mismas claves
-- que la URL del inbox). Devuelve condiciones « and … » sobre los alias l (leads) y s
-- (lead_inbox_summary). Un valor desconocido de estado/rango no filtra (igual que
-- antes en el navegador); la ruta de la API ya valida los valores.
-- «El agente responde la etapa del lead» (pestaña de la lista), como condición SQL sobre
-- l: sin etapa o etapa fuera de ignored_stage_ids (fail-open, como process-inbound).
create or replace function inbox_etapa_agente_sql()
returns text language sql immutable set search_path = public, pg_temp as $$
  select '(l.kommo_stage_id is null or not coalesce(l.kommo_stage_id = any ((select c.ignored_stage_ids'
         ' from kommo_publish_config c where c.is_active limit 1)::bigint[]), false))'
$$;

create or replace function inbox_filter_sql(p_filters jsonb)
returns text language plpgsql immutable set search_path = public, pg_temp as $$
declare
  f jsonb := case when jsonb_typeof(p_filters) = 'object' then p_filters else '{}'::jsonb end;
  v_q text := nullif(btrim(coalesce(f->>'q', '')), '');
  v_channel text := nullif(f->>'channel', '');
  v_vertical text := nullif(f->>'vertical', '');
  v_estado text := nullif(f->>'estado', '');
  v_rango text := nullif(f->>'rango', '');
  out text := '';
begin
  if v_q is not null then
    out := out || format(
      ' and strpos(lower(coalesce(l.display_name, '''') || '' '' || coalesce(l.kommo_lead_id::text, '''') || '' '' || coalesce(s.last_content, '''')), lower(%L)) > 0',
      v_q);
  end if;
  if v_channel is not null then
    -- Misma normalización que normChannel() (web/src/lib/inbox-data.ts).
    out := out || format(
      ' and (case when lower(coalesce(l.channel, '''')) like ''%%whatsapp%%'' or lower(l.channel) = ''waba'' then ''whatsapp'''
      ' when lower(coalesce(l.channel, '''')) like ''%%instagram%%'' then ''instagram'''
      ' when lower(coalesce(l.channel, '''')) like ''%%facebook%%'' or lower(l.channel) = ''fb'' then ''facebook'''
      ' when lower(coalesce(l.channel, '''')) like ''%%tiktok%%'' then ''tiktok'''
      ' when lower(coalesce(l.channel, '''')) like ''%%telegram%%'' then ''telegram'''
      ' else ''other'' end) = %L',
      v_channel);
  end if;
  if v_vertical is not null then
    out := out || format(' and %L = any (s.verticals)', v_vertical);
  end if;
  if coalesce(f->>'urgent', '') in ('true', '1') then
    out := out || ' and s.max_urgency >= 4';
  end if;
  out := out || case f->>'etapa'
    when 'agente' then ' and ' || inbox_etapa_agente_sql()
    when 'apagadas' then ' and not ' || inbox_etapa_agente_sql()
    else '' end;
  out := out || case v_estado
    when 'review'   then ' and s.has_review_pending'
    when 'waiting'  then ' and s.awaiting_reply'
    when 'answered' then ' and s.last_reply_at is not null'
    when 'toxic'    then ' and s.max_toxicity > 0.3'
    else '' end;
  out := out || case v_rango
    when '1h'    then ' and l.last_message_at >= now() - interval ''1 hour'''
    when 'today' then ' and l.last_message_at >= now() - interval ''24 hours'''
    when '7d'    then ' and l.last_message_at >= now() - interval ''7 days'''
    when '30d'   then ' and l.last_message_at >= now() - interval ''30 days'''
    else '' end;
  return out;
end $$;

-- ── 6) Una rebanada paginada ─────────────────────────────────────────────────
-- p_pipeline: null = todos (vista Lista); -1 = «Sin pipeline» (sin pipeline o en uno
-- archivado/desconocido); -2 = «No existe en Kommo»; > 0 = ese pipeline.
-- p_stage (solo con p_pipeline > 0): null = todo el pipeline; -1 = «Etapa
-- desconocida» (etapa nula o que ya no está en el pipeline); > 0 = esa etapa.
-- p_sort: recent | oldest | urgency | messages. p_after: cursor devuelto como
-- `next` por la página anterior ({t, id} y, en urgency/messages, k).
-- Devuelve { rows: [...], next: cursor | null }.
create or replace function inbox_page(
  p_pipeline bigint default null,
  p_stage bigint default null,
  p_filters jsonb default '{}'::jsonb,
  p_sort text default 'recent',
  p_after jsonb default null,
  p_limit int default 50
) returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_sort text := case when p_sort in ('recent', 'oldest', 'urgency', 'messages') then p_sort else 'recent' end;
  v_ts constant text := 'coalesce(l.last_message_at, ''-infinity''::timestamptz)';
  v_key text := case v_sort when 'urgency' then 's.max_urgency' when 'messages' then 's.msg_count' end;
  v_scope text;
  v_order text;
  v_keyset text := '';
  v_rows jsonb[] := '{}';
  v_next jsonb := null;
  v_n int := 0;
  rec record;
begin
  v_scope := case
    when p_pipeline is null then ''
    when p_pipeline = -2 then ' and l.kommo_missing_at is not null'
    when p_pipeline = -1 then
      ' and l.kommo_missing_at is null and (l.kommo_pipeline_id is null or not exists ('
      'select 1 from kommo_pipelines kp where kp.id = l.kommo_pipeline_id and not kp.is_archive))'
    when p_stage is null then format(' and l.kommo_missing_at is null and l.kommo_pipeline_id = %L', p_pipeline)
    when p_stage = -1 then format(
      ' and l.kommo_missing_at is null and l.kommo_pipeline_id = %1$L and (l.kommo_stage_id is null or not exists ('
      'select 1 from kommo_stages ks where ks.pipeline_id = %1$L and ks.id = l.kommo_stage_id))', p_pipeline)
    else format(' and l.kommo_missing_at is null and l.kommo_pipeline_id = %L and l.kommo_stage_id = %L', p_pipeline, p_stage)
  end;

  v_order := case v_sort
    when 'oldest' then v_ts || ' asc, l.id asc'
    when 'recent' then v_ts || ' desc, l.id desc'
    else v_key || ' desc, ' || v_ts || ' desc, l.id desc'
  end;

  if p_after is not null and jsonb_typeof(p_after) = 'object' then
    v_keyset := case v_sort
      when 'oldest' then format(' and (%s, l.id) > (%L::timestamptz, %L::uuid)', v_ts, p_after->>'t', p_after->>'id')
      when 'recent' then format(' and (%s, l.id) < (%L::timestamptz, %L::uuid)', v_ts, p_after->>'t', p_after->>'id')
      else format(' and (%s, %s, l.id) < (%L::numeric, %L::timestamptz, %L::uuid)',
                  v_key, v_ts, p_after->>'k', p_after->>'t', p_after->>'id')
    end;
  end if;

  -- limit + 1: la fila de más dice si hay otra página (sin contar el total). La
  -- subconsulta elige y ordena SOLO claves; el JSON se arma después y solo para las
  -- filas elegidas (armado junto al orden se calculaba para todo el conjunto filtrado).
  for rec in execute format(
    'select x.id, x.t, x.k::text as k, jsonb_build_object('
    '''id'', l.id, ''display_name'', l.display_name, ''channel'', l.channel, ''kommo_lead_id'', l.kommo_lead_id,'
    '''kommo_pipeline_id'', l.kommo_pipeline_id, ''kommo_stage_id'', l.kommo_stage_id,'
    '''kommo_missing_at'', l.kommo_missing_at, ''last_message_at'', l.last_message_at,'
    '''msg_count'', s.msg_count, ''last_content'', s.last_content, ''last_direction'', s.last_direction,'
    '''last_created_at'', s.last_created_at, ''last_vertical'', s.last_vertical,'
    '''has_review_pending'', s.has_review_pending, ''max_urgency'', s.max_urgency, ''max_toxicity'', s.max_toxicity,'
    '''verticals'', s.verticals, ''awaiting_reply'', s.awaiting_reply, ''last_reply_at'', s.last_reply_at) as j'
    ' from (select l.id, %s as t, %s as k'
    '         from leads l join lead_inbox_summary s on s.lead_id = l.id'
    '        where true%s%s%s'
    '        order by %s limit %s) x'
    ' join leads l on l.id = x.id join lead_inbox_summary s on s.lead_id = x.id'
    ' order by %s',
    v_ts, coalesce(v_key, 'null::numeric'),
    v_scope, inbox_filter_sql(p_filters), v_keyset, v_order, v_limit + 1,
    case v_sort when 'oldest' then 'x.t asc, x.id asc' when 'recent' then 'x.t desc, x.id desc'
                else 'x.k desc, x.t desc, x.id desc' end)
  loop
    v_n := v_n + 1;
    if v_n > v_limit then
      exit;
    end if;
    v_rows := array_append(v_rows, rec.j);
    -- to_jsonb conserva los microsegundos (y '-infinity') del instante: el cursor
    -- vuelve exacto, sin el redondeo a milisegundos de un Date de JS.
    v_next := jsonb_build_object('t', to_jsonb(rec.t), 'id', rec.id, 'k', rec.k);
  end loop;
  if v_n <= v_limit then
    v_next := null;
  end if;
  return jsonb_build_object('rows', to_jsonb(v_rows), 'next', v_next);
end $$;

-- ── 7) El tablero de un pipeline en una llamada ──────────────────────────────
-- p_pipeline inválido/archivado/null → el primero (el principal, después el orden
-- de Kommo); sin pipelines → -1. Columnas: una por etapa del pipeline (clave = id
-- de la etapa) + «otras» (Etapa desconocida) si tiene leads; en -1/-2, una sola
-- («all»). Cada columna: { total, rows, next }. p_limits: { "<clave>": n } para
-- recargar una columna con las tarjetas que ya tenía abiertas («Ver más»).
create or replace function inbox_board(
  p_pipeline bigint default null,
  p_filters jsonb default '{}'::jsonb,
  p_sort text default 'recent',
  p_limit int default 30,
  p_limits jsonb default null
) returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_pipeline bigint;
  v_filters text := inbox_filter_sql(p_filters);
  v_counts jsonb;
  v_cols jsonb := '{}'::jsonb;
  v_key text;
  v_total bigint;
  st record;
  lim int;
begin
  if p_pipeline in (-1, -2) then
    v_pipeline := p_pipeline;
  elsif exists (select 1 from kommo_pipelines where id = p_pipeline and not is_archive) then
    v_pipeline := p_pipeline;
  else
    select id into v_pipeline from kommo_pipelines where not is_archive order by is_main desc, sort, id limit 1;
    v_pipeline := coalesce(v_pipeline, -1);
  end if;

  if v_pipeline < 0 then
    lim := coalesce((p_limits->>'all')::int, p_limit);
    execute format(
      'select count(*) from leads l join lead_inbox_summary s on s.lead_id = l.id where true%s%s',
      case when v_pipeline = -2 then ' and l.kommo_missing_at is not null'
           else ' and l.kommo_missing_at is null and (l.kommo_pipeline_id is null or not exists ('
                'select 1 from kommo_pipelines kp where kp.id = l.kommo_pipeline_id and not kp.is_archive))' end,
      v_filters) into v_total;
    v_cols := jsonb_build_object('all',
      jsonb_build_object('total', v_total)
        || case when v_total > 0 then inbox_page(v_pipeline, null, p_filters, p_sort, null, lim)
                else '{"rows": [], "next": null}'::jsonb end);
    return jsonb_build_object('pipeline', v_pipeline, 'columns', v_cols);
  end if;

  -- Totales por columna con los MISMOS filtros (un solo recorrido del pipeline).
  execute format(
    'select coalesce(jsonb_object_agg(col, n), ''{}''::jsonb) from ('
    ' select case when exists (select 1 from kommo_stages ks where ks.pipeline_id = %1$L and ks.id = l.kommo_stage_id)'
    '             then l.kommo_stage_id::text else ''otras'' end as col, count(*) as n'
    '   from leads l join lead_inbox_summary s on s.lead_id = l.id'
    '  where l.kommo_missing_at is null and l.kommo_pipeline_id = %1$L%2$s'
    '  group by 1) x',
    v_pipeline, v_filters) into v_counts;

  for st in select id from kommo_stages where pipeline_id = v_pipeline order by sort, id loop
    v_key := st.id::text;
    v_total := coalesce((v_counts->>v_key)::bigint, 0);
    lim := coalesce((p_limits->>v_key)::int, p_limit);
    v_cols := v_cols || jsonb_build_object(v_key,
      jsonb_build_object('total', v_total)
        || case when v_total > 0 then inbox_page(v_pipeline, st.id, p_filters, p_sort, null, lim)
                else '{"rows": [], "next": null}'::jsonb end);
  end loop;
  v_total := coalesce((v_counts->>'otras')::bigint, 0);
  if v_total > 0 then
    lim := coalesce((p_limits->>'otras')::int, p_limit);
    v_cols := v_cols || jsonb_build_object('otras',
      jsonb_build_object('total', v_total) || inbox_page(v_pipeline, -1, p_filters, p_sort, null, lim));
  end if;
  return jsonb_build_object('pipeline', v_pipeline, 'columns', v_cols);
end $$;

-- ── 8) Encabezado, pestañas y opciones de filtro ─────────────────────────────
-- total / review / awaiting_all: sin filtros. filtered / awaiting / pipelines: con filtros.
-- etapa: conteos de las pestañas de la lista con los filtros (sin el de la pestaña).
-- pipelines: { "<id>" | "-1" | "-2": n } con la misma regla que inbox_page.
-- channels: valores CRUDOS de leads.channel (la web los normaliza); verticals: slugs.
create or replace function inbox_stats(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_total bigint;
  v_review bigint;
  v_buckets jsonb;
  v_filtered bigint;
  v_awaiting bigint;
  v_channels jsonb;
  v_verticals jsonb;
  v_awaiting_all bigint;
  v_etapa jsonb;
begin
  select count(*), count(*) filter (where has_review_pending), count(*) filter (where awaiting_reply)
    into v_total, v_review, v_awaiting_all from lead_inbox_summary;
  execute format(
    'select jsonb_build_object(''agente'', count(*) filter (where %1$s), ''apagadas'', count(*) filter (where not %1$s),'
    ' ''todas'', count(*)) from leads l join lead_inbox_summary s on s.lead_id = l.id where true%2$s',
    inbox_etapa_agente_sql(), inbox_filter_sql(coalesce(p_filters, '{}'::jsonb) - 'etapa')) into v_etapa;

  execute format(
    'select coalesce(jsonb_object_agg(b::text, n), ''{}''::jsonb), coalesce(sum(n), 0), coalesce(sum(w), 0) from ('
    ' select case when l.kommo_missing_at is not null then -2'
    '             when exists (select 1 from kommo_pipelines kp where kp.id = l.kommo_pipeline_id and not kp.is_archive)'
    '             then l.kommo_pipeline_id else -1 end as b,'
    '        count(*) as n, count(*) filter (where s.awaiting_reply) as w'
    '   from leads l join lead_inbox_summary s on s.lead_id = l.id'
    '  where true%s'
    '  group by 1) x',
    inbox_filter_sql(p_filters)) into v_buckets, v_filtered, v_awaiting;

  select coalesce(jsonb_agg(c order by c), '[]'::jsonb) into v_channels
    from (select distinct l.channel as c
            from leads l join lead_inbox_summary s on s.lead_id = l.id
           where l.channel is not null) x;
  select coalesce(jsonb_agg(v order by v), '[]'::jsonb) into v_verticals
    from (select distinct unnest(verticals) as v from lead_inbox_summary) x;

  return jsonb_build_object(
    'total', v_total, 'review', v_review, 'awaiting_all', v_awaiting_all, 'etapa', v_etapa,
    'filtered', v_filtered, 'awaiting', v_awaiting,
    'pipelines', v_buckets,
    'channels', v_channels, 'verticals', v_verticals);
end $$;

-- ── 9) Permisos ──────────────────────────────────────────────────────────────
-- El panel llama a estas con la sesión (RLS del usuario). inbox_filter_sql e
-- inbox_etapa_agente_sql son puras (arman texto) y las ejecutan las otras con el
-- rol del que consulta.
revoke execute on function inbox_filter_sql(jsonb), inbox_etapa_agente_sql(),
  inbox_page(bigint, bigint, jsonb, text, jsonb, int),
  inbox_board(bigint, jsonb, text, int, jsonb), inbox_stats(jsonb) from public, anon;
grant execute on function inbox_filter_sql(jsonb), inbox_etapa_agente_sql(),
  inbox_page(bigint, bigint, jsonb, text, jsonb, int),
  inbox_board(bigint, jsonb, text, int, jsonb), inbox_stats(jsonb) to authenticated, service_role;

-- La función que calculaba TODO el resumen en cada llamada ya no la usa nadie. Una
-- web anterior a 0085 la necesita: volver la web atrás exige recrearla (su definición
-- está en 0061).
drop function if exists inbox_lead_summaries();
