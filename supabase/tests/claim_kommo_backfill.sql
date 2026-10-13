-- Prueba de escenarios de la migración 0061 contra un Postgres con TODAS las
-- migraciones aplicadas (descartable: borra leads y reescribe kommo_backfill):
--   · claim_kommo_backfill (lease, cursor, enfriamiento del reinicio),
--   · apply_lead_position (orden de eventos, evento solo si se aplicó),
--   · apply_kommo_lead_positions (lectura de página vs. webhook más nuevo),
--   · kommo_missing_candidates / mark_kommo_leads_missing / kommo_gap_lead_ids,
--   · claim_kommo_pipelines_refresh y permisos / search_path.
--
--   sed 's#${SUPABASE_URL}#http://x.test#g' supabase/migrations/*.sql | psql ...   (una vez)
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/claim_kommo_backfill.sql
--
-- Cada assert aborta con la descripción del caso si no se cumple.
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

delete from lead_stage_events where true;
delete from leads where true;
delete from kommo_backfill_seen where true;
update kommo_backfill set status='pending', next_page=1, scanned=0, updated=0, lease_until=null,
       started_at=null, finished_at=null, updated_at=now() - interval '1 day' where job='lead_positions';

-- 1) Primer reclamo: continúa ('claimed'), aunque pidan restart; no rebobina.
select pg_temp.expect('primer reclamo = claimed',
  (select outcome from claim_kommo_backfill('lead_positions', 150, true)) = 'claimed');
-- 2) Con lease vigente: busy (ni restart ni continue).
select pg_temp.expect('lease vigente = busy',
  (select outcome from claim_kommo_backfill('lead_positions', 150, true)) = 'busy');

-- 3) Corrida a medio camino (pending, página 7): un restart NO rebobina.
update kommo_backfill set status='pending', next_page=7, scanned=1500, updated=40, lease_until=null where job='lead_positions';
select pg_temp.expect('restart sobre pending continúa en la página 7 (no rebobina)',
  (select outcome = 'claimed' and next_page = 7 and scanned = 1500 from claim_kommo_backfill('lead_positions', 150, true)));

-- 3b) 'failed' sin lease: se retoma tal cual, aunque pidan restart y sin enfriamiento (S6).
update kommo_backfill set status='failed', next_page=5, scanned=900, lease_until=null, updated_at=now() where job='lead_positions';
select pg_temp.expect('failed se retoma desde su cursor sin enfriamiento y sin rebobinar',
  (select outcome = 'claimed' and next_page = 5 and scanned = 900 from claim_kommo_backfill('lead_positions', 150, true)));

-- 4) 'done' recién terminado + restart → cooldown con retry_after > 0 y sin tocar nada.
update kommo_backfill set status='done', next_page=9, scanned=2000, updated=50, lease_until=null,
       finished_at=now(), updated_at=now() where job='lead_positions';
select pg_temp.expect('done reciente + restart = cooldown con espera',
  (select outcome = 'cooldown' and retry_after_seconds between 1 and 900 and next_page = 9
     from claim_kommo_backfill('lead_positions', 150, true)));
select pg_temp.expect('el cooldown no cambió el estado', (select status = 'done' and scanned = 2000 from kommo_backfill where job='lead_positions'));
select pg_temp.expect('done sin restart = done (nada que hacer)',
  (select outcome from claim_kommo_backfill('lead_positions', 150, false)) = 'done');

-- 5) 'done' pasado el enfriamiento + restart → restarted desde la página 1.
update kommo_backfill set updated_at = now() - interval '16 minutes', finished_at = now() - interval '16 minutes' where job='lead_positions';
select pg_temp.expect('done viejo + restart = restarted, página 1, contadores a 0',
  (select outcome = 'restarted' and next_page = 1 and scanned = 0 and updated = 0 from claim_kommo_backfill('lead_positions', 150, true)));
select pg_temp.expect('segundo restart inmediato = busy',
  (select outcome from claim_kommo_backfill('lead_positions', 150, true)) = 'busy');
update kommo_backfill set next_page = 4, scanned = 750, lease_until = null where job='lead_positions';
select pg_temp.expect('restart sobre running sin lease continúa en la 4',
  (select outcome = 'claimed' and next_page = 4 from claim_kommo_backfill('lead_positions', 150, true)));

-- 6) Un 'done' NO se reabre por leads nuevos: los huecos se completan por id (W4).
update kommo_backfill set status='done', lease_until=null, finished_at=now() - interval '5 hours', updated_at=now() - interval '5 hours' where job='lead_positions';
delete from leads where true;
insert into leads (kommo_lead_id, created_at, last_message_at) values (101, now() - interval '3 hours', now() - interval '1 hour');
select pg_temp.expect('un lead sin pipeline NO reabre el recorrido completo',
  (select outcome from claim_kommo_backfill('lead_positions', 150, false)) = 'done');
select pg_temp.expect('kommo_gap_lead_ids lo devuelve', (select array_agg(g) from kommo_gap_lead_ids(10) g) = array[101]::bigint[]);
update leads set kommo_missing_at = now() where kommo_lead_id = 101;
select pg_temp.expect('marcado inexistente deja de ser hueco', (select count(*) from kommo_gap_lead_ids(10)) = 0);
update leads set kommo_missing_at = null, kommo_pipeline_id = 1 where kommo_lead_id = 101;
select pg_temp.expect('con pipeline deja de ser hueco', (select count(*) from kommo_gap_lead_ids(10)) = 0);

-- 7) Orden de eventos: apply_lead_position (W2).
delete from leads where true;
insert into leads (id, kommo_lead_id, kommo_pipeline_id, kommo_stage_id) values
  ('00000000-0000-0000-0000-0000000000a1', 201, 1, 10);
-- primera vez (sin kommo_position_at): se aplica con etapa previa = movimiento + evento
select pg_temp.expect('A→B en t=100: applied + moved + evento',
  (select outcome = 'applied' and moved and event_id is not null
     from apply_lead_position('00000000-0000-0000-0000-0000000000a1', 11, 1, to_timestamp(100))));
-- llega el evento B→C (t=300) ANTES que el viejo (t=200), como pasa con dos workers
select pg_temp.expect('t=300 → etapa 12: applied',
  (select outcome = 'applied' and moved from apply_lead_position('00000000-0000-0000-0000-0000000000a1', 12, 1, to_timestamp(300))));
select pg_temp.expect('t=200 llega tarde → stale, NO retrocede ni registra evento',
  (select outcome = 'stale' and not moved and event_id is null
     from apply_lead_position('00000000-0000-0000-0000-0000000000a1', 11, 1, to_timestamp(200))));
select pg_temp.expect('la etapa sigue en 12 y hay 2 eventos (no 3)',
  (select kommo_stage_id = 12 and kommo_position_at = to_timestamp(300) from leads where kommo_lead_id = 201)
  and (select count(*) = 2 from lead_stage_events where lead_id = '00000000-0000-0000-0000-0000000000a1'));
-- (las funciones modifican filas: cada lectura de verificación va en SU statement,
-- porque un subselect del mismo statement no ve lo que escribió la función)
select pg_temp.expect('mismo estado = unchanged',
  (select outcome = 'unchanged' from apply_lead_position('00000000-0000-0000-0000-0000000000a1', 12, 1, to_timestamp(400))));
select pg_temp.expect('unchanged no escribe (position_at intacto)',
  (select kommo_position_at = to_timestamp(300) from leads where kommo_lead_id = 201));
select pg_temp.expect('webhook sin pipeline: applied',
  (select outcome = 'applied' from apply_lead_position('00000000-0000-0000-0000-0000000000a1', 13, null, to_timestamp(500))));
select pg_temp.expect('webhook sin pipeline no pisa el pipeline guardado',
  (select kommo_pipeline_id = 1 and kommo_stage_id = 13 from leads where kommo_lead_id = 201));
select pg_temp.expect('142 en el mismo pipeline: movimiento',
  (select moved from apply_lead_position('00000000-0000-0000-0000-0000000000a1', 142, 1, to_timestamp(600))));
select pg_temp.expect('142 en OTRO pipeline es movimiento aunque no cambie el id de etapa',
  (select moved from apply_lead_position('00000000-0000-0000-0000-0000000000a1', 142, 2, to_timestamp(700))));
select pg_temp.expect('lead inexistente = missing',
  (select outcome from apply_lead_position(gen_random_uuid(), 1, 1, now())) = 'missing');
-- primera vez que se ve la etapa (null): se aplica pero NO es movimiento
insert into leads (id, kommo_lead_id) values ('00000000-0000-0000-0000-0000000000a2', 202);
select pg_temp.expect('null → etapa: applied sin movimiento ni evento',
  (select outcome = 'applied' and not moved and event_id is null
     from apply_lead_position('00000000-0000-0000-0000-0000000000a2', 10, 1, to_timestamp(50))));
-- señal de vida limpia la marca aun con evento viejo
update leads set kommo_missing_at = now() where kommo_lead_id = 202;
select pg_temp.expect('un evento stale: outcome stale',
  (select outcome = 'stale' from apply_lead_position('00000000-0000-0000-0000-0000000000a2', 99, 1, to_timestamp(10))));
select pg_temp.expect('…y también limpia kommo_missing_at',
  (select kommo_missing_at is null from leads where kommo_lead_id = 202));
-- eco del panel: el agente/panel aplica con now(); el webhook trae un instante anterior → stale, un solo evento
insert into leads (id, kommo_lead_id, kommo_pipeline_id, kommo_stage_id) values ('00000000-0000-0000-0000-0000000000a3', 203, 1, 10);
select * from apply_lead_position('00000000-0000-0000-0000-0000000000a3', 11, 1, now(), 'kommo', null, 'Pedro (desde el panel)');
select * from apply_lead_position('00000000-0000-0000-0000-0000000000a3', 11, 1, now() - interval '2 seconds');
select pg_temp.expect('panel + eco = UN evento, con el actor',
  (select count(*) = 1 and max(actor_name) = 'Pedro (desde el panel)' from lead_stage_events where lead_id = '00000000-0000-0000-0000-0000000000a3'));

-- eco PRIMERO: el webhook llega antes que el panel → el evento anónimo se completa con el actor
insert into leads (id, kommo_lead_id, kommo_pipeline_id, kommo_stage_id) values ('00000000-0000-0000-0000-0000000000a4', 204, 1, 10);
select * from apply_lead_position('00000000-0000-0000-0000-0000000000a4', 11, 1, now() + interval '1 second');
select pg_temp.expect('eco primero: se registró 1 evento anónimo',
  (select count(*) = 1 and max(actor_name) is null from lead_stage_events where lead_id = '00000000-0000-0000-0000-0000000000a4'));
select pg_temp.expect('el panel llega después (stale o unchanged según los relojes): devuelve el evento completado',
  (select outcome in ('stale', 'unchanged') and not moved and event_id is not null
     from apply_lead_position('00000000-0000-0000-0000-0000000000a4', 11, 1, now(), 'kommo', null, 'Ana (desde el panel)')));
select pg_temp.expect('…el evento quedó con el actor y NO se creó otro',
  (select count(*) = 1 and max(actor_name) = 'Ana (desde el panel)' from lead_stage_events where lead_id = '00000000-0000-0000-0000-0000000000a4'));
select pg_temp.expect('un unchanged SIN actor no inventa ni toca eventos',
  (select event_id is null from apply_lead_position('00000000-0000-0000-0000-0000000000a4', 11, 1, now() + interval '2 seconds')));
-- el agente tras un eco, sin evento reciente que completar (>120 s): merge_only no inserta
update lead_stage_events set created_at = now() - interval '10 minutes' where lead_id = '00000000-0000-0000-0000-0000000000a4';
select pg_temp.expect('sin evento reciente que completar, merge_only no inserta',
  (select event_id is null from apply_lead_position('00000000-0000-0000-0000-0000000000a4', 11, 1, now() + interval '3 seconds', 'agente')));
select pg_temp.expect('…y sigue habiendo 1 solo evento', (select count(*) = 1 from lead_stage_events where lead_id = '00000000-0000-0000-0000-0000000000a4'));

-- 8) apply_kommo_lead_positions respeta kommo_position_at (W2 vs backfill)
delete from lead_stage_events where true;
delete from leads where true;
insert into leads (kommo_lead_id, kommo_pipeline_id, kommo_stage_id, kommo_position_at) values
  (301, 1, 10, to_timestamp(1000)),   -- un webhook más nuevo que la lectura ya fijó 10
  (302, 1, 10, null);
select pg_temp.expect('lectura en t=500: cambia solo 1 (302)',
  apply_kommo_lead_positions('[{"id":301,"pipeline_id":2,"status_id":99},{"id":302,"pipeline_id":2,"status_id":99}]'::jsonb, to_timestamp(500)) = 1);
select pg_temp.expect('…no pisa la posición fijada en t=1000 (301) y sí la de 302',
  (select kommo_stage_id = 10 from leads where kommo_lead_id = 301)
  and (select kommo_stage_id = 99 and kommo_position_at = to_timestamp(500) from leads where kommo_lead_id = 302));
select pg_temp.expect('el backfill no escribe eventos', (select count(*) = 0 from lead_stage_events));

-- 9) Recorrido completo: candidatos a inexistentes (W3). NO marca: solo propone.
delete from leads where true;
insert into leads (kommo_lead_id, created_at, kommo_pipeline_id, kommo_stage_id) values
  (1, now() - interval '5 days', 1, 10),   -- visto
  (2, now() - interval '5 days', 1, 10),   -- no visto: ¿borrado o página saltada?
  (3, now() - interval '5 days', null, null), -- no visto, nunca tuvo pipeline
  (4, now() + interval '1 hour', null, null); -- nace "después" del inicio
insert into leads (kommo_lead_id, created_at, kommo_pipeline_id, kommo_stage_id, kommo_position_at) values
  (5, now() - interval '5 days', 1, 10, now() + interval '1 minute'); -- señal de vida posterior al inicio
update kommo_backfill set status='done', lease_until=null, finished_at=now() - interval '1 hour', updated_at=now() - interval '1 hour' where job='lead_positions';
select outcome from claim_kommo_backfill('lead_positions', 150, true);  -- restarted: vacía lo visto, started_at = now()
select pg_temp.expect('sin hojas vistas no hay candidatos',
  (select count(*) = 0 from kommo_missing_candidates('lead_positions')));
select apply_kommo_lead_positions('[{"id":1,"pipeline_id":2,"status_id":20}]'::jsonb);
select pg_temp.expect('candidatos = 2 y 3 (no el visto, ni el nacido después, ni el que mostró vida)',
  (select array_agg(c order by c) from kommo_missing_candidates('lead_positions') c) = array[2,3]::bigint[]);
select pg_temp.expect('proponer no marca nada', (select count(*) = 0 from leads where kommo_missing_at is not null));
-- Kommo confirma por id: el 2 SÍ existe (la página lo saltó) y se aplica; el 3 no existe.
select apply_kommo_lead_positions('[{"id":2,"pipeline_id":1,"status_id":10}]'::jsonb);
select pg_temp.expect('el 2 verificado ya no es candidato', (select array_agg(c) from kommo_missing_candidates('lead_positions') c) = array[3]::bigint[]);
select pg_temp.expect('mark marca solo los confirmados ausentes', mark_kommo_leads_missing(array[3]::bigint[]) = 1);
select pg_temp.expect('mark es idempotente', mark_kommo_leads_missing(array[3]::bigint[]) = 0);
select pg_temp.expect('el 3 queda marcado; 1, 2, 4 y 5 no',
  (select bool_and((kommo_missing_at is not null) = (kommo_lead_id = 3)) from leads));
-- Kommo vuelve a devolver el 3 (restaurado): apply limpia la marca.
select apply_kommo_lead_positions('[{"id":3,"pipeline_id":1,"status_id":10}]'::jsonb);
select pg_temp.expect('volver a verlo limpia la marca', (select kommo_missing_at is null from leads where kommo_lead_id = 3));

-- 10) Un nuevo recorrido (página 1) vacía lo visto.
update kommo_backfill set status='done', lease_until=null, updated_at=now() - interval '1 hour', finished_at=now() - interval '1 hour' where job='lead_positions';
select outcome from claim_kommo_backfill('lead_positions', 150, true);
select pg_temp.expect('restart vacía kommo_backfill_seen', (select count(*) from kommo_backfill_seen) = 0);

-- 11) Freno de pipelines en la base.
delete from kommo_sync_state where true;
select pg_temp.expect('primer refresco: gana', claim_kommo_pipelines_refresh(30));
select pg_temp.expect('segundo inmediato: frenado', not claim_kommo_pipelines_refresh(30));
update kommo_sync_state set last_at = now() - interval '31 seconds';
select pg_temp.expect('pasados 30 s: gana otra vez', claim_kommo_pipelines_refresh(30));

-- 12) Permisos: solo service_role.
select pg_temp.expect('anon/authenticated no ejecutan ninguna función de escritura de 0061',
  not exists (
    select 1
      from unnest(array[
        'claim_kommo_backfill(text,int,boolean,int)',
        'apply_lead_position(uuid,bigint,bigint,timestamptz,text,uuid,text,text,text,text,uuid)',
        'record_lead_stage_event(uuid,bigint,bigint,bigint,bigint,text,text,text,text,uuid,text,int,boolean,uuid)',
        'apply_kommo_lead_positions(jsonb,timestamptz)',
        'kommo_missing_candidates(text,int)',
        'kommo_gap_lead_ids(int)',
        'mark_kommo_leads_missing(bigint[])',
        'claim_kommo_pipelines_refresh(int)',
        'sync_kommo_pipelines(jsonb)',
        'trigger_sync_pipelines()'
      ]) f
     where has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
        or has_function_privilege('public', f, 'execute'))
  and has_function_privilege('service_role', 'apply_lead_position(uuid,bigint,bigint,timestamptz,text,uuid,text,text,text,text,uuid)', 'execute'));
select pg_temp.expect('inbox_lead_summaries sí es del panel', has_function_privilege('authenticated', 'inbox_lead_summaries()', 'execute')
  and not has_function_privilege('anon', 'inbox_lead_summaries()', 'execute'));

-- 13) search_path fijo en TODAS las funciones de 0061 (y la de 0060), y las
-- SECURITY DEFINER con pg_temp al final (S5).
select pg_temp.expect('todas las funciones de 0061/0060 fijan search_path = public, pg_temp',
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('sync_kommo_pipelines','record_lead_stage_event','apply_lead_position','inbox_lead_summaries',
                         'claim_kommo_pipelines_refresh','claim_kommo_backfill','apply_kommo_lead_positions',
                         'kommo_missing_candidates','kommo_gap_lead_ids','mark_kommo_leads_missing',
                         'trigger_sync_pipelines','gasto_mes_actual')
       and coalesce(p.proconfig, '{}'::text[]) <> array['search_path=public, pg_temp']));

-- 14) Webhook autenticado (0073): instantes futuros recortados + estado/secretos/funciones.
delete from lead_stage_events where true;
delete from leads where true;
insert into leads (id, kommo_lead_id, kommo_pipeline_id, kommo_stage_id) values
  ('00000000-0000-0000-0000-0000000000b1', 301, 1, 10);
-- un payload con last_modified en el AÑO 2100 NO puede congelar al lead
select pg_temp.expect('instante de 2100: se aplica pero recortado a ~now()',
  (select outcome = 'applied' from apply_lead_position('00000000-0000-0000-0000-0000000000b1', 11, 1, '2100-01-01'::timestamptz)));
select pg_temp.expect('kommo_position_at quedó <= now() + 2 min (no 2100)',
  (select kommo_position_at <= now() + interval '2 minutes' from leads where id = '00000000-0000-0000-0000-0000000000b1'));
-- y el evento REAL posterior (ahora + 5 min) no se descarta como viejo
select pg_temp.expect('el evento real siguiente se aplica (el lead no quedó congelado)',
  (select outcome = 'applied' and moved from apply_lead_position('00000000-0000-0000-0000-0000000000b1', 12, 1, clock_timestamp() + interval '1 second')));
select pg_temp.expect('un evento legítimo viejo sigue siendo stale (orden invertido)',
  (select outcome = 'stale' from apply_lead_position('00000000-0000-0000-0000-0000000000b1', 10, 1, now() - interval '1 day')));

select pg_temp.expect('existe el secreto del webhook y no es corto',
  (select length(valor) >= 32 from _app_secrets where clave = 'KOMMO_WEBHOOK_SECRET'));
select pg_temp.expect('el singleton arranca permisivo',
  (select mode = 'permissive' from kommo_webhook_auth where singleton));
select pg_temp.expect('anon/authenticated no leen _app_secrets ni escriben kommo_webhook_auth',
  not has_table_privilege('anon', '_app_secrets', 'select') and not has_table_privilege('authenticated', '_app_secrets', 'select')
  and not has_table_privilege('anon', 'kommo_webhook_auth', 'select')
  and has_table_privilege('authenticated', 'kommo_webhook_auth', 'select')
  and not has_table_privilege('authenticated', 'kommo_webhook_auth', 'update'));
select pg_temp.expect('kommo_webhook_note: solo service_role',
  has_function_privilege('service_role', 'kommo_webhook_note(boolean)', 'execute')
  and not has_function_privilege('anon', 'kommo_webhook_note(boolean)', 'execute')
  and not has_function_privilege('authenticated', 'kommo_webhook_note(boolean)', 'execute')
  and not has_function_privilege('public', 'kommo_webhook_note(boolean)', 'execute'));

-- sin secreto en modo permisivo: alerta (una sola en 6 h) y sigue permisivo
delete from alerts where kind = 'webhook_unsigned';
select pg_temp.expect('request sin secreto: devuelve permissive', (select kommo_webhook_note(false)) = 'permissive');
select kommo_webhook_note(false);
select pg_temp.expect('una sola alerta webhook_unsigned por ventana de 6 h',
  (select count(*) = 1 from alerts where kind = 'webhook_unsigned'));
-- una request firmada con unsigned reciente NO pasa a strict (transición)
select kommo_webhook_note(true);
select pg_temp.expect('firmada con unsigned reciente: sigue permisivo',
  (select mode = 'permissive' from kommo_webhook_auth where singleton));
-- pasadas strict_after_hours sin unsigned: pasa solo a strict
update kommo_webhook_auth set last_unsigned_at = now() - interval '25 hours' where singleton;
select pg_temp.expect('firmada + 25 h sin unsigned: strict automático', (select kommo_webhook_note(true)) = 'strict');
select pg_temp.expect('quedó strict con motivo auto',
  (select mode = 'strict' and strict_reason = 'auto' and strict_since is not null from kommo_webhook_auth where singleton));
-- instalación nueva (nunca hubo unsigned) + primera request firmada = strict de entrada
update kommo_webhook_auth set mode = 'permissive', strict_since = null, strict_reason = null, last_unsigned_at = null where singleton;
select pg_temp.expect('nunca hubo unsigned: la primera firmada pasa a strict', (select kommo_webhook_note(true)) = 'strict');
update kommo_webhook_auth set mode = 'permissive', strict_since = null, strict_reason = null, last_unsigned_at = null,
       last_signed_at = null where singleton;

-- 15) W1 (orden con 'unchanged') y actor_user_id (0065 consolidada).
delete from lead_stage_events where true;
delete from leads where true;
insert into leads (id, kommo_lead_id, kommo_pipeline_id, kommo_stage_id) values
  ('00000000-0000-0000-0000-0000000000c1', 401, 1, 10);
-- agente A->B @T5; webhook B @T8 (unchanged, avanza la marca); A @T6 llegado TARDE -> stale
select apply_lead_position('00000000-0000-0000-0000-0000000000c1', 11, 1, to_timestamp(1000005), 'agente');
select pg_temp.expect('webhook B@T8 sobre B: unchanged',
  (select outcome = 'unchanged' from apply_lead_position('00000000-0000-0000-0000-0000000000c1', 11, 1, to_timestamp(1000008))));
select pg_temp.expect('el unchanged avanzo la marca de orden a T8 (sin tocar leads)',
  (select seen_at = to_timestamp(1000008) from lead_position_seen where lead_id = '00000000-0000-0000-0000-0000000000c1')
  and (select kommo_position_at = to_timestamp(1000005) from leads where id = '00000000-0000-0000-0000-0000000000c1'));
select pg_temp.expect('A@T6 tardio es stale: la posicion NO vuelve a A',
  (select outcome = 'stale' from apply_lead_position('00000000-0000-0000-0000-0000000000c1', 10, 1, to_timestamp(1000006))));
select pg_temp.expect('el lead sigue en B', (select kommo_stage_id = 11 from leads where id = '00000000-0000-0000-0000-0000000000c1'));
select pg_temp.expect('un evento posterior (T9) si se aplica',
  (select outcome = 'applied' from apply_lead_position('00000000-0000-0000-0000-0000000000c1', 12, 1, to_timestamp(1000009))));
-- normalizacion a segundos: mismo segundo con ms = empate, se aplica
select pg_temp.expect('mismo segundo con ms (panel) y Kommo en segundos: no se descarta',
  (select outcome = 'applied' from apply_lead_position('00000000-0000-0000-0000-0000000000c1', 11, 1, to_timestamp(1000009.9))));

-- backfill: una lectura posterior tambien avanza la marca y bloquea un evento viejo tardio
select apply_kommo_lead_positions('[{"id":401,"pipeline_id":1,"status_id":11}]'::jsonb, to_timestamp(1000020));
select pg_temp.expect('la lectura (T20) avanzo la marca aunque la posicion no cambio',
  (select seen_at = to_timestamp(1000020) from lead_position_seen where lead_id = '00000000-0000-0000-0000-0000000000c1'));
select pg_temp.expect('un webhook de T12 llegado despues de la lectura T20 es stale',
  (select outcome = 'stale' from apply_lead_position('00000000-0000-0000-0000-0000000000c1', 12, 1, to_timestamp(1000012))));

-- actor_user_id: queda en el evento y borrar al usuario no borra el historial
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000d1') on conflict do nothing;
select apply_lead_position('00000000-0000-0000-0000-0000000000c1', 13, 1, to_timestamp(1000030), 'kommo', null,
  'ana@x.com (desde el panel)', null, 'Etapa 13', null, '00000000-0000-0000-0000-0000000000d1');
select pg_temp.expect('el evento guarda actor_user_id',
  (select count(*) = 1 from lead_stage_events where actor_user_id = '00000000-0000-0000-0000-0000000000d1'));
delete from auth.users where id = '00000000-0000-0000-0000-0000000000d1';
select pg_temp.expect('borrar al usuario deja el evento con actor_user_id NULL y el nombre de respaldo',
  (select actor_user_id is null and actor_name like 'ana@x.com%' from lead_stage_events where to_stage_id = 13));

-- 16) Serializacion de movimientos del panel por lead (claim_lead_move / release_lead_move).
delete from lead_move_claims where true;
delete from lead_stage_events where true;
delete from leads where true;
insert into leads (id, kommo_lead_id, kommo_pipeline_id, kommo_stage_id) values
  ('00000000-0000-0000-0000-0000000000e1', 501, 1, 10);
select pg_temp.expect('claim con la posicion esperada: claimed con token',
  (select outcome = 'claimed' and token is not null from claim_lead_move('00000000-0000-0000-0000-0000000000e1', true, 10, 1)));
select pg_temp.expect('segundo claim del mismo lead mientras hay uno en vuelo: busy y sin token',
  (select outcome = 'busy' and token is null from claim_lead_move('00000000-0000-0000-0000-0000000000e1', true, 10, 1)));
select pg_temp.expect('un token AJENO no libera la reserva',
  not release_lead_move('00000000-0000-0000-0000-0000000000e1', gen_random_uuid()));
select pg_temp.expect('un token NULL no libera la reserva',
  not release_lead_move('00000000-0000-0000-0000-0000000000e1', null));
select pg_temp.expect('…la reserva sigue tomada (busy)',
  (select outcome = 'busy' from claim_lead_move('00000000-0000-0000-0000-0000000000e1', false)));
select pg_temp.expect('el dueño libera con su token',
  release_lead_move('00000000-0000-0000-0000-0000000000e1', (select token from lead_move_claims where lead_id = '00000000-0000-0000-0000-0000000000e1')));
select pg_temp.expect('liberado: se puede reservar de nuevo',
  (select outcome = 'claimed' from claim_lead_move('00000000-0000-0000-0000-0000000000e1', false)));
-- TTL vencido: el viejo dueño (A) tarda, B toma la reserva; el release tardio de A NO borra la de B.
create temp table t_tok (who text primary key, token uuid);
insert into t_tok select 'A', token from lead_move_claims where lead_id = '00000000-0000-0000-0000-0000000000e1';
update lead_move_claims set claimed_at = clock_timestamp() - interval '44 seconds' where lead_id = '00000000-0000-0000-0000-0000000000e1';
select pg_temp.expect('dentro del TTL por defecto (44 s de 45) la reserva NO vence',
  (select outcome = 'busy' from claim_lead_move('00000000-0000-0000-0000-0000000000e1', false)));
update lead_move_claims set claimed_at = clock_timestamp() - interval '46 seconds' where lead_id = '00000000-0000-0000-0000-0000000000e1';
insert into t_tok select 'B', token from claim_lead_move('00000000-0000-0000-0000-0000000000e1', false) where outcome = 'claimed';
select pg_temp.expect('TTL por defecto (45 s) vencido: un nuevo dueño (B) toma la reserva con OTRO token',
  (select count(*) = 2 and count(distinct token) = 2 from t_tok));
select pg_temp.expect('el release tardio del viejo dueño (A) no borra la reserva de B',
  not release_lead_move('00000000-0000-0000-0000-0000000000e1', (select token from t_tok where who = 'A')));
select pg_temp.expect('…la reserva sigue siendo de B',
  (select token = (select token from t_tok where who = 'B') from lead_move_claims where lead_id = '00000000-0000-0000-0000-0000000000e1'));
select pg_temp.expect('…y un tercero sigue bloqueado (busy)',
  (select outcome = 'busy' from claim_lead_move('00000000-0000-0000-0000-0000000000e1', false)));
select pg_temp.expect('B libera con su token',
  release_lead_move('00000000-0000-0000-0000-0000000000e1', (select token from t_tok where who = 'B')));
-- la reserva vence sola (servidor caido): con ttl 0 un claim nuevo la toma
select claim_lead_move('00000000-0000-0000-0000-0000000000e1', false);
select pg_temp.expect('una reserva vencida no bloquea el lead',
  (select outcome = 'claimed' from claim_lead_move('00000000-0000-0000-0000-0000000000e1', false, null, null, 0)));
delete from lead_move_claims where true;
select pg_temp.expect('posicion distinta de la esperada: position_changed con la vigente y sin token',
  (select outcome = 'position_changed' and stage_id = 10 and pipeline_id = 1 and token is null
     from claim_lead_move('00000000-0000-0000-0000-0000000000e1', true, 99, 1)));
select pg_temp.expect('position_changed no deja reserva tomada',
  (select outcome = 'claimed' from claim_lead_move('00000000-0000-0000-0000-0000000000e1', true, 10, 1)));
delete from lead_move_claims where true;
select pg_temp.expect('lead inexistente: missing',
  (select outcome = 'missing' from claim_lead_move('00000000-0000-0000-0000-0000000000ff', false)));
select pg_temp.expect('claim/release solo para service_role',
  has_function_privilege('service_role', 'claim_lead_move(uuid,boolean,bigint,bigint,int)', 'execute')
  and not has_function_privilege('authenticated', 'claim_lead_move(uuid,boolean,bigint,bigint,int)', 'execute')
  and not has_function_privilege('anon', 'release_lead_move(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'release_lead_move(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'release_lead_move(uuid,uuid)', 'execute')
  and not has_table_privilege('authenticated', 'lead_move_claims', 'select'));

rollback;
