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
        'apply_lead_position(uuid,bigint,bigint,timestamptz,text,uuid,text,text,text,text)',
        'record_lead_stage_event(uuid,bigint,bigint,bigint,bigint,text,text,text,text,uuid,text,int,boolean)',
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
  and has_function_privilege('service_role', 'apply_lead_position(uuid,bigint,bigint,timestamptz,text,uuid,text,text,text,text)', 'execute'));
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

rollback;
