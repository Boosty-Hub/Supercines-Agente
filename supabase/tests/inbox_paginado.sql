-- Inbox paginado (0085): resumen guardado por triggers, rebanadas por keyset, tablero, stats y
-- filtros, contra un Postgres con TODAS las migraciones aplicadas.
--   1) lead_inbox_summary = la fórmula (inbox_summary_upsert) después de insertar, editar y borrar
--      mensajes/drafts, mover un mensaje de lead y renombrar una vertical: los triggers no divergen.
--   2) Semántica del resumen: último mensaje/respuesta, «sin responder», revisión, máximos.
--   3) inbox_board: columnas por etapa + «otras», totales con filtros, pipeline por default,
--      pseudo-pipelines -1/-2, p_limits.
--   4) inbox_page: keyset estable en los 4 órdenes (empates de instante y NULL incluidos): recorrer
--      página a página da exactamente el orden completo, sin repetir ni saltar.
--   5) Filtros (q, channel, vertical, urgent, estado, rango) y inbox_stats.
--   6) RLS y permisos: operacion ve, sin rol no ve nada, anon no ejecuta.
--   7) Propio de SuperCines: pestañas de la lista por ignored_stage_ids (filtro `etapa`, fail-open)
--      con sus conteos (con los demás filtros) y el «sin responder» del inbox completo.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/inbox_paginado.sql   (ver supabase/tests/README.md)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- Resumen guardado = fórmula recalculada desde cero (sin refreshed_at).
create or replace function pg_temp.resumen_coincide() returns boolean language plpgsql as $$
declare n int;
begin
  create temp table if not exists snap as select * from lead_inbox_summary where false;
  truncate snap;
  insert into snap select * from lead_inbox_summary;
  perform inbox_summary_upsert(array(select id from leads));
  -- leads sin mensajes que quedaron con fila (no debería): el upsert los borra; se cuentan.
  select count(*) into n from (
    (select lead_id, msg_count, last_content, last_direction, last_created_at, last_vertical, has_review_pending,
            max_urgency, max_toxicity, verticals, awaiting_reply, last_reply_at from snap
     except
     select lead_id, msg_count, last_content, last_direction, last_created_at, last_vertical, has_review_pending,
            max_urgency, max_toxicity, verticals, awaiting_reply, last_reply_at from lead_inbox_summary)
    union all
    (select lead_id, msg_count, last_content, last_direction, last_created_at, last_vertical, has_review_pending,
            max_urgency, max_toxicity, verticals, awaiting_reply, last_reply_at from lead_inbox_summary
     except
     select lead_id, msg_count, last_content, last_direction, last_created_at, last_vertical, has_review_pending,
            max_urgency, max_toxicity, verticals, awaiting_reply, last_reply_at from snap)) d;
  return n = 0;
end $$;

-- ── Datos ────────────────────────────────────────────────────────────────────
delete from lead_stage_events where true;
delete from leads where true;
insert into verticals (id, slug, name, system_prompt) values
  ('00000000-0000-0000-0000-0000000000a1', 'zz_precios', 'Precios', 'x'),
  ('00000000-0000-0000-0000-0000000000a2', 'zz_horarios', 'Horarios', 'x');
insert into kommo_pipelines (id, name, sort, is_main, is_archive) values
  (9002, 'Soporte', 2, false, false), (9001, 'Ventas', 5, true, false), (9003, 'Viejo', 1, false, true);
insert into kommo_stages (pipeline_id, id, name, sort) values
  (9001, 900101, 'Nuevo', 10), (9001, 900102, 'Cotizado', 20), (9001, 142, 'Ganado', 90), (9001, 143, 'Perdido', 91),
  (9002, 900201, 'Abierto', 10), (9003, 900301, 'Archivado', 10);

-- t0 fijo con microsegundos (el cursor tiene que volver exacto).
create temp table t0 as select timestamptz '2026-10-01 12:00:00.123456+00' as t;
insert into leads (id, kommo_lead_id, display_name, channel, kommo_pipeline_id, kommo_stage_id, kommo_missing_at, last_message_at)
select v.id::uuid, v.k, v.n, v.ch, v.p, v.s, case when v.miss then now() end, (select t from t0) - v.h * interval '1 hour'
  from (values
    ('00000000-0000-0000-0000-000000000001', 1, 'Ana Pérez',    'WhatsApp Business', 9001, 900101, false, 1),
    ('00000000-0000-0000-0000-000000000002', 2, 'Beto Ruiz',    'waba',              9001, 900101, false, 2),
    ('00000000-0000-0000-0000-000000000003', 3, 'Caro Díaz',    'instagram',         9001, 900102, false, 3),
    ('00000000-0000-0000-0000-000000000004', 4, 'Dani Gómez',   'fb',                9001, 777,    false, 4),
    ('00000000-0000-0000-0000-000000000005', 5, 'Eli Soto',     null,                9001, null,   false, 5),
    ('00000000-0000-0000-0000-000000000006', 6, 'Fede Luna',    'telegram',          null, null,   false, 6),
    ('00000000-0000-0000-0000-000000000007', 7, 'Gabi Mora',    'tiktok',            9003, 900301, false, 7),
    ('00000000-0000-0000-0000-000000000008', 8, 'Hugo Paz',     'whatsapp',          9001, 900101, true,  8),
    ('00000000-0000-0000-0000-000000000009', 9, 'Iris Sin Msj', 'whatsapp',          9001, 900101, false, 9),
    ('00000000-0000-0000-0000-000000000010', 10, 'Juan Empate', 'whatsapp',          9002, 900201, false, 10),
    ('00000000-0000-0000-0000-000000000011', 11, 'Karla Empate','whatsapp',          9002, 900201, false, 10),
    ('00000000-0000-0000-0000-000000000012', 12, 'Leo Empate',  'whatsapp',          9002, 900201, false, 10),
    ('00000000-0000-0000-0000-000000000013', 13, 'Mia Nula',    'whatsapp',          9002, 900201, false, 0),
    ('00000000-0000-0000-0000-000000000014', 14, 'Nico Nulo',   'whatsapp',          9002, 900201, false, 0)
  ) v(id, k, n, ch, p, s, miss, h);
update leads set last_message_at = null where kommo_lead_id in (13, 14);
-- Lead 1 tiene un instante viejo para el filtro de rango (lo demás también es «viejo» respecto a
-- now(): t0 es fijo). El rango se prueba con un lead puesto en now().
update leads set last_message_at = now() - interval '10 minutes' where kommo_lead_id = 3;

-- Mensajes: inbound/outbound, clasificación, revisión, verticales.
insert into messages (id, lead_id, direction, content, vertical_id, classification, requires_human_review, created_at)
select v.id::uuid, ('00000000-0000-0000-0000-0000000000' || lpad(v.l::text, 2, '0'))::uuid, v.dir, v.c, v.vert::uuid,
       v.cls::jsonb, v.rev, (select t from t0) - v.m * interval '1 minute'
  from (values
    ('10000000-0000-0000-0000-000000000001', 1, 'inbound',  'hola quiero precios', '00000000-0000-0000-0000-0000000000a1', '{"urgency": 2, "toxicity": 0.1}', false, 70),
    ('10000000-0000-0000-0000-000000000002', 1, 'outbound', 'te paso la lista',    null, null, false, 65),
    ('10000000-0000-0000-0000-000000000003', 1, 'inbound',  'gracias, ¿y el horario?', '00000000-0000-0000-0000-0000000000a2', '{"urgency": "4.5", "toxicity": 0}', false, 60),
    ('10000000-0000-0000-0000-000000000004', 2, 'inbound',  'necesito un humano',  null, '{"urgency": 1, "toxicity": 0.8}', true, 120),
    ('10000000-0000-0000-0000-000000000005', 3, 'inbound',  'urgente!!',           '00000000-0000-0000-0000-0000000000a1', '{"urgency": 5, "toxicity": "x"}', false, 180),
    ('10000000-0000-0000-0000-000000000006', 4, 'inbound',  'otra etapa',          null, null, false, 240),
    ('10000000-0000-0000-0000-000000000007', 5, 'inbound',  'sin etapa',           null, null, false, 300),
    ('10000000-0000-0000-0000-000000000008', 6, 'inbound',  'sin pipeline',        null, null, false, 360),
    ('10000000-0000-0000-0000-000000000009', 7, 'inbound',  'archivado',           null, null, false, 420),
    ('10000000-0000-0000-0000-000000000010', 8, 'inbound',  'borrado en kommo',    null, null, false, 480),
    ('10000000-0000-0000-0000-000000000011', 10, 'inbound', 'empate a',            null, '{"urgency": 3}', false, 600),
    ('10000000-0000-0000-0000-000000000012', 11, 'inbound', 'empate b',            null, '{"urgency": 3}', false, 600),
    ('10000000-0000-0000-0000-000000000013', 12, 'inbound', 'empate c',            null, '{"urgency": 3}', false, 600),
    ('10000000-0000-0000-0000-000000000014', 13, 'inbound', 'nula a',              null, null, false, 700),
    ('10000000-0000-0000-0000-000000000015', 14, 'inbound', 'nula b',              null, null, false, 700)
  ) v(id, l, dir, c, vert, cls, rev, m);

-- Lead 1: respuesta enviada DESPUÉS de su último inbound → no está «sin responder».
insert into drafts (id, message_id, body, edited_body, status, sent_at) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'cuerpo original', 'cuerpo editado', 'sent',
   (select t from t0) - interval '50 minutes');
-- Lead 2: draft pendiente (no cuenta).
insert into drafts (id, message_id, body, status) values
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000004', 'pendiente', 'pending');

-- ── 1+2) Resumen ─────────────────────────────────────────────────────────────
select pg_temp.expect('una fila por lead CON mensajes (el lead sin mensajes no tiene)',
  (select count(*) from lead_inbox_summary) = 13
  and not exists (select 1 from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000009'));
select pg_temp.expect('lead 1: último = respuesta editada enviada, outbound, no sin responder, verticales y urgencia',
  exists (select 1 from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000001'
             and msg_count = 3 and last_content = 'cuerpo editado' and last_direction = 'outbound'
             and not awaiting_reply and last_reply_at = (select t from t0) - interval '50 minutes'
             and max_urgency = 4.5 and max_toxicity = 0.1 and verticals = array['zz_horarios', 'zz_precios']
             and last_vertical = 'zz_horarios'));
select pg_temp.expect('lead 2: revisión pendiente, sin responder (draft pendiente no cuenta), toxicidad',
  exists (select 1 from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000002'
             and has_review_pending and awaiting_reply and last_reply_at is null and max_toxicity = 0.8
             and last_direction = 'inbound' and verticals = '{}'));
select pg_temp.expect('valores no numéricos de la clasificación se ignoran',
  (select max_toxicity = 0 and max_urgency = 5 from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000003'));
select pg_temp.expect('resumen inicial = fórmula', pg_temp.resumen_coincide());

-- Mutaciones de todo tipo y el resumen sigue igual a la fórmula.
insert into messages (lead_id, direction, content, created_at)
  values ('00000000-0000-0000-0000-000000000001', 'inbound', 'una más', (select t from t0) - interval '10 minutes');
select pg_temp.expect('nuevo inbound después de la respuesta → sin responder',
  (select awaiting_reply and last_content = 'una más' and msg_count = 4 from lead_inbox_summary
    where lead_id = '00000000-0000-0000-0000-000000000001'));
update messages set ignored = true where content = 'una más';
select pg_temp.expect('silenciado a propósito → no sin responder',
  (select not awaiting_reply from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000001'));
update messages set requires_human_review = false where id = '10000000-0000-0000-0000-000000000004';
select pg_temp.expect('el panel quita la revisión → el resumen la quita',
  (select not has_review_pending from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000002'));
update drafts set status = 'sent', sent_at = (select t from t0) where id = '20000000-0000-0000-0000-000000000002';
select pg_temp.expect('draft enviado → última respuesta y ya no sin responder',
  (select not awaiting_reply and last_content = 'pendiente' and last_direction = 'outbound'
     from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000002'));
update drafts set edited_body = 'pendiente corregido' where id = '20000000-0000-0000-0000-000000000002';
select pg_temp.expect('editar el texto de un draft enviado actualiza el último contenido',
  (select last_content = 'pendiente corregido' from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000002'));
delete from drafts where id = '20000000-0000-0000-0000-000000000002';
select pg_temp.expect('borrar el draft enviado → vuelve a sin responder',
  (select awaiting_reply and last_reply_at is null from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000002'));
update messages set classification = '{"urgency": 4, "toxicity": 0.9}' where id = '10000000-0000-0000-0000-000000000010';
update messages set lead_id = '00000000-0000-0000-0000-000000000006' where id = '10000000-0000-0000-0000-000000000007';
select pg_temp.expect('mover un mensaje de lead recalcula ORIGEN (sin mensajes → sin fila) y DESTINO',
  not exists (select 1 from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000005')
  and (select msg_count = 2 from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000006'));
update messages set lead_id = '00000000-0000-0000-0000-000000000005' where id = '10000000-0000-0000-0000-000000000007';
update verticals set slug = 'zz_tarifas' where id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.expect('renombrar una vertical actualiza los slugs guardados',
  (select verticals = array['zz_horarios', 'zz_tarifas'] from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000001'));
update verticals set slug = 'zz_precios' where id = '00000000-0000-0000-0000-0000000000a1';
update messages set source = 'ruido' where true; -- columna que el resumen no lee
select pg_temp.expect('tras todas las mutaciones el resumen = fórmula', pg_temp.resumen_coincide());

-- Ruido masivo + borrado: 1 sentencia sobre muchos leads.
insert into messages (lead_id, direction, content, created_at)
  select id, 'outbound', 'masivo', (select t from t0) - interval '30 minutes' from leads where kommo_lead_id between 10 and 14;
delete from messages where content = 'masivo' and lead_id = '00000000-0000-0000-0000-000000000010';
select pg_temp.expect('inserción/borrado de varias filas en una sentencia: resumen = fórmula', pg_temp.resumen_coincide());
delete from messages where content = 'masivo';

-- ── 3) Tablero ───────────────────────────────────────────────────────────────
create temp table b as select inbox_board(null) as j;
select pg_temp.expect('sin pipeline pedido → el principal (9001)', (select (j->>'pipeline')::bigint = 9001 from b));
select pg_temp.expect('columnas = etapas del pipeline + otras',
  (select array_agg(k order by k) from b, jsonb_object_keys(j->'columns') k)
  = array['142', '143', '900101', '900102', 'otras']);
select pg_temp.expect('Nuevo: Ana y Beto (Hugo no existe en Kommo, Iris no tiene mensajes), por última actividad',
  (select array_agg(r->>'display_name' order by o) from b, jsonb_array_elements(j->'columns'->'900101'->'rows') with ordinality x(r, o))
  = array['Ana Pérez', 'Beto Ruiz']
  and (select (j->'columns'->'900101'->>'total')::int = 2 and j->'columns'->'900101'->'next' = 'null'::jsonb from b));
select pg_temp.expect('otras: etapa desconocida y etapa nula',
  (select array_agg(r->>'display_name' order by r->>'display_name') from b, jsonb_array_elements(j->'columns'->'otras'->'rows') r)
  = array['Dani Gómez', 'Eli Soto']);
select pg_temp.expect('columna vacía: total 0, sin filas',
  (select j->'columns'->'142' = '{"total": 0, "rows": [], "next": null}'::jsonb from b));
select pg_temp.expect('pipeline archivado → cae al principal',
  (inbox_board(9003)->>'pipeline')::bigint = 9001);
select pg_temp.expect('Sin pipeline (-1): sin pipeline o en uno archivado',
  (select array_agg(r->>'display_name' order by r->>'display_name')
     from jsonb_array_elements(inbox_board(-1)->'columns'->'all'->'rows') r) = array['Fede Luna', 'Gabi Mora']);
select pg_temp.expect('No existe en Kommo (-2)',
  (select array_agg(r->>'display_name') from jsonb_array_elements(inbox_board(-2)->'columns'->'all'->'rows') r) = array['Hugo Paz']);
select pg_temp.expect('p_limit + p_limits por columna: total completo y next presente',
  (select (c->>'total')::int = 5 and jsonb_array_length(c->'rows') = 2 and c->'next' <> 'null'::jsonb
     from (select inbox_board(9002, '{}', 'recent', 1, '{"900201": 2}')->'columns'->'900201' as c) x));
select pg_temp.expect('filtro en el tablero: totales por columna con el filtro',
  (select (c->'900101'->>'total')::int = 1 and (c->'900102'->>'total')::int = 0
     from (select inbox_board(9001, '{"q": "ana"}')->'columns' as c) x));

-- ── 4) Keyset: recorrer página a página = orden completo, en los 4 órdenes ─────
create or replace function pg_temp.recorrer(p_pipeline bigint, p_stage bigint, p_sort text, p_size int)
returns uuid[] language plpgsql as $$
declare out uuid[] := '{}'; cur jsonb := null; pg jsonb; i int := 0;
begin
  loop
    pg := inbox_page(p_pipeline, p_stage, '{}', p_sort, cur, p_size);
    out := out || array(select (r->>'id')::uuid from jsonb_array_elements(pg->'rows') r);
    cur := pg->'next';
    exit when cur is null or cur = 'null'::jsonb;
    i := i + 1;
    if i > 100 then raise exception 'recorrer: no termina'; end if;
  end loop;
  return out;
end $$;
create or replace function pg_temp.esperado(p_pipeline bigint, p_sort text) returns uuid[] language sql as $$
  select array_agg(l.id order by
    case when p_sort = 'urgency' then s.max_urgency when p_sort = 'messages' then s.msg_count end desc nulls last,
    case when p_sort = 'oldest' then coalesce(l.last_message_at, '-infinity') end asc,
    case when p_sort = 'oldest' then l.id end asc,
    case when p_sort <> 'oldest' then coalesce(l.last_message_at, '-infinity') end desc,
    case when p_sort <> 'oldest' then l.id end desc)
  from leads l join lead_inbox_summary s on s.lead_id = l.id
  where p_pipeline is null or (l.kommo_pipeline_id = p_pipeline and l.kommo_missing_at is null)
$$;
select pg_temp.expect('keyset ' || s || ' tamaño ' || n || ': igual al orden completo, sin repetidos',
  pg_temp.recorrer(null, null, s, n) = pg_temp.esperado(null, s)
  and cardinality(pg_temp.recorrer(null, null, s, n)) = (select count(*) from lead_inbox_summary))
  from unnest(array['recent', 'oldest', 'urgency', 'messages']) s, unnest(array[1, 2, 3, 50]) n;
select pg_temp.expect('keyset dentro de una etapa con empates de instante y NULL (' || s || ')',
  pg_temp.recorrer(9002, 900201, s, 1) = pg_temp.esperado(9002, s))
  from unnest(array['recent', 'oldest', 'urgency', 'messages']) s;
select pg_temp.expect('el cursor conserva los microsegundos del instante',
  (select inbox_page(9001, 900101, '{}', 'recent', null, 1)->'next'->>'t' like '%.123456+00:00'));
select pg_temp.expect('el cursor de una fila con instante NULL es -infinity y sigue funcionando',
  (select inbox_page(9002, 900201, '{}', 'recent', null, 4)->'next'->>'t' = '-infinity'));
select pg_temp.expect('límite acotado a 500 y como mínimo 1',
  jsonb_array_length(inbox_page(null, null, '{}', 'recent', null, 0)->'rows') = 1);

-- ── 5) Filtros y stats ───────────────────────────────────────────────────────
create or replace function pg_temp.nombres(p_filters jsonb) returns text[] language sql as $$
  select coalesce(array_agg(r->>'display_name' order by r->>'display_name'), '{}')
    from jsonb_array_elements(inbox_page(null, null, p_filters, 'recent', null, 500)->'rows') r
$$;
select pg_temp.expect('q por nombre (sin mayúsculas)', pg_temp.nombres('{"q": "BETO"}') = array['Beto Ruiz']);
select pg_temp.expect('q por id de Kommo', pg_temp.nombres('{"q": "12"}') = array['Leo Empate']);
select pg_temp.expect('q por último contenido', pg_temp.nombres('{"q": "urgente"}') = array['Caro Díaz']);
select pg_temp.expect('q con comodines de LIKE no es un patrón', pg_temp.nombres('{"q": "%"}') = '{}');
-- Un patrón de backtracking catastrófico se trata como texto literal y no tarda: la búsqueda
-- es strpos (sin regex) y el término se corta a 200 caracteres.
update leads set display_name = 'Nombre ' || repeat('a', 5000) || '!' where kommo_lead_id = 14;
create temp table redos as select clock_timestamp() as t0,
  pg_temp.nombres(jsonb_build_object('q', '(a+)+$')) as r1,
  pg_temp.nombres(jsonb_build_object('q', repeat('(a*)*', 5000) || 'b')) as r2,
  pg_temp.nombres(jsonb_build_object('q', '(a+)+')) as r3,
  clock_timestamp() as t1;
select pg_temp.expect('patrones de ReDoS = texto literal, sin coincidencias y en < 1 s',
  (select r1 = '{}' and r2 = '{}' and r3 = '{}' and t1 - t0 < interval '1 second' from redos));
select pg_temp.expect('el término se corta a 200 caracteres en SQL',
  inbox_filter_sql(jsonb_build_object('q', repeat('x', 5000))) like '%''' || repeat('x', 200) || '''%'
  and inbox_filter_sql(jsonb_build_object('q', repeat('x', 5000))) not like '%' || repeat('x', 201) || '%');
update leads set display_name = 'Nico Nulo' where kommo_lead_id = 14;
select pg_temp.expect('canal normalizado: whatsapp incluye waba y "WhatsApp Business"',
  pg_temp.nombres('{"channel": "whatsapp"}') @> array['Ana Pérez', 'Beto Ruiz']
  and not (pg_temp.nombres('{"channel": "whatsapp"}') && array['Dani Gómez', 'Eli Soto']));
select pg_temp.expect('canal: fb → facebook, null → other',
  pg_temp.nombres('{"channel": "facebook"}') = array['Dani Gómez'] and pg_temp.nombres('{"channel": "other"}') = array['Eli Soto']);
select pg_temp.expect('vertical', pg_temp.nombres('{"vertical": "zz_horarios"}') = array['Ana Pérez']);
select pg_temp.expect('urgentes (>= 4)', pg_temp.nombres('{"urgent": true}') = array['Ana Pérez', 'Caro Díaz', 'Hugo Paz']);
select pg_temp.expect('estado review', pg_temp.nombres('{"estado": "review"}') = '{}');
update messages set requires_human_review = true where id = '10000000-0000-0000-0000-000000000004';
select pg_temp.expect('estado review (tras marcar)', pg_temp.nombres('{"estado": "review"}') = array['Beto Ruiz']);
select pg_temp.expect('estado answered', pg_temp.nombres('{"estado": "answered"}') = array['Ana Pérez']);
select pg_temp.expect('estado toxic (> 0.3)', pg_temp.nombres('{"estado": "toxic"}') = array['Beto Ruiz', 'Hugo Paz']);
select pg_temp.expect('estado waiting',
  not ('Ana Pérez' = any (pg_temp.nombres('{"estado": "waiting"}'))) and 'Beto Ruiz' = any (pg_temp.nombres('{"estado": "waiting"}')));
select pg_temp.expect('rango 1h', pg_temp.nombres('{"rango": "1h"}') = array['Caro Díaz']);
select pg_temp.expect('valores desconocidos no filtran',
  cardinality(pg_temp.nombres('{"estado": "zzz", "rango": "zzz"}')) = 13);

create temp table st as select inbox_stats('{}') as j;
select pg_temp.expect('stats: total, revisión, sin responder y buckets por pipeline',
  (select (j->>'total')::int = 13 and (j->>'review')::int = 1 and (j->>'filtered')::int = 13
          and j->'pipelines' = '{"9001": 5, "9002": 5, "-1": 2, "-2": 1}'::jsonb from st));
select pg_temp.expect('stats: sin responder = filas con awaiting_reply',
  (select (j->>'awaiting')::int = (select count(*) from lead_inbox_summary where awaiting_reply) from st));
select pg_temp.expect('stats: opciones de filtro (canales crudos y verticales)',
  (select j->'verticals' = '["zz_horarios", "zz_precios"]'::jsonb and j->'channels' ? 'waba' from st));
select pg_temp.expect('stats con filtro: total/revisión sin filtro, el resto filtrado',
  (select (j->>'total')::int = 13 and (j->>'filtered')::int = 1 and j->'pipelines' = '{"9001": 1}'::jsonb
     from (select inbox_stats('{"q": "beto"}') as j) x));

-- ── 7) SuperCines: pestañas Con agente / Apagadas / Todas ────────────────────
update kommo_publish_config set ignored_stage_ids = '{}' where is_active;
insert into kommo_publish_config (is_active, ignored_stage_ids)
  select true, '{}' where not exists (select 1 from kommo_publish_config where is_active);
select pg_temp.expect('sin etapas ignoradas: todo «con agente»',
  cardinality(pg_temp.nombres('{"etapa": "agente"}')) = 13 and pg_temp.nombres('{"etapa": "apagadas"}') = '{}'
  and (select inbox_stats('{}')->'etapa' = '{"agente": 13, "apagadas": 0, "todas": 13}'::jsonb));
update kommo_publish_config set ignored_stage_ids = '{900201, 777}' where is_active;
-- apagadas = etapa ignorada (Juan/Karla/Leo/Mia/Nico en 900201, Dani en 777); sin etapa = con agente.
select pg_temp.expect('pestaña apagadas: etapas ignoradas',
  pg_temp.nombres('{"etapa": "apagadas"}') = array['Dani Gómez', 'Juan Empate', 'Karla Empate', 'Leo Empate', 'Mia Nula', 'Nico Nulo']);
select pg_temp.expect('pestaña con agente: el complemento (sin etapa incluida)',
  pg_temp.nombres('{"etapa": "agente"}') = array['Ana Pérez', 'Beto Ruiz', 'Caro Díaz', 'Eli Soto', 'Fede Luna', 'Gabi Mora', 'Hugo Paz']);
select pg_temp.expect('conteos de las pestañas con los demás filtros (y sin el de la pestaña)',
  (select inbox_stats('{"q": "empate", "etapa": "agente"}')->'etapa' = '{"agente": 0, "apagadas": 3, "todas": 3}'::jsonb));
select pg_temp.expect('awaiting_all = sin responder del inbox completo (no cambia con filtros)',
  (select (inbox_stats('{"q": "zzz"}')->>'awaiting_all')::int = (select count(*) from lead_inbox_summary where awaiting_reply)));

-- ── 6) RLS y permisos ────────────────────────────────────────────────────────
create temp table vista (k text, n int);
grant insert on vista to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated","app_metadata":{"role":"operacion"}}', true);
insert into vista select 'operacion', (inbox_stats('{}')->>'total')::int;
insert into vista select 'operacion_board', (inbox_board(9001)->'columns'->'900101'->>'total')::int;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}', true);
insert into vista select 'sin_rol', (inbox_stats('{}')->>'total')::int;
insert into vista select 'sin_rol_page', jsonb_array_length(inbox_page(null, null, '{}', 'recent', null, 50)->'rows');
reset role;
select pg_temp.expect('operacion ve el inbox con su sesión',
  (select n from vista where k = 'operacion') = 13 and (select n from vista where k = 'operacion_board') = 2);
select pg_temp.expect('sin rol: 0 filas (RLS del resumen y de leads)',
  (select n from vista where k = 'sin_rol') = 0 and (select n from vista where k = 'sin_rol_page') = 0);
select pg_temp.expect('anon no ejecuta ninguna; authenticated solo las del panel; la sesión no escribe el resumen',
  not has_function_privilege('anon', 'inbox_board(bigint,jsonb,text,int,jsonb)', 'execute')
  and not has_function_privilege('anon', 'inbox_page(bigint,bigint,jsonb,text,jsonb,int)', 'execute')
  and not has_function_privilege('anon', 'inbox_stats(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'inbox_summary_refresh(uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'inbox_summary_upsert(uuid[])', 'execute')
  and not has_table_privilege('authenticated', 'lead_inbox_summary', 'insert')
  and not has_table_privilege('authenticated', 'lead_inbox_summary', 'update')
  and not has_table_privilege('anon', 'lead_inbox_summary', 'select'));

-- El panel (authenticated, operacion) marca la revisión de un mensaje: el trigger (SECURITY
-- DEFINER) actualiza el resumen aunque la sesión no pueda escribirlo.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated","app_metadata":{"role":"operacion"}}', true);
update messages set requires_human_review = false where id = '10000000-0000-0000-0000-000000000004';
reset role;
select pg_temp.expect('una escritura del panel con su sesión actualiza el resumen',
  (select not has_review_pending from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000002'));

-- Sentencia masiva (> 100 leads → lock global exclusivo en vez de uno por lead).
insert into leads (id, kommo_lead_id, display_name, last_message_at)
  select gen_random_uuid(), 800000 + g, 'Masivo ' || g, now() from generate_series(1, 150) g;
insert into messages (lead_id, direction, content) select id, 'inbound', 'masivo' from leads where kommo_lead_id >= 800000;
select pg_temp.expect('inserción que toca 150 leads: resumen = fórmula',
  (select count(*) = 150 from lead_inbox_summary s join leads l on l.id = s.lead_id where l.kommo_lead_id >= 800000)
  and pg_temp.resumen_coincide());

delete from leads where id = '00000000-0000-0000-0000-000000000001';
select pg_temp.expect('borrar el lead borra su resumen (cascada)',
  not exists (select 1 from lead_inbox_summary where lead_id = '00000000-0000-0000-0000-000000000001')
  and pg_temp.resumen_coincide());

-- TRUNCATE (sin filas de transición): se recalcula todo; sin mensajes, queda vacío.
truncate drafts cascade;
select pg_temp.expect('TRUNCATE drafts (arrastra messages): el resumen queda vacío', not exists (select 1 from lead_inbox_summary));

rollback;
