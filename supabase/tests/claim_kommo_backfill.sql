-- Prueba de escenarios de claim_kommo_backfill / mark_kommo_missing_leads /
-- claim_kommo_pipelines_refresh (migración 0065) contra un Postgres con TODAS
-- las migraciones aplicadas (descartable: borra leads y reescribe kommo_backfill).
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
-- y un segundo restart inmediato ya no rebobina (lease vigente)
select pg_temp.expect('segundo restart inmediato = busy',
  (select outcome from claim_kommo_backfill('lead_positions', 150, true)) = 'busy');
-- aun sin lease, está 'running': continúa, no rebobina
update kommo_backfill set next_page = 4, scanned = 750, lease_until = null where job='lead_positions';
select pg_temp.expect('restart sobre running sin lease continúa en la 4',
  (select outcome = 'claimed' and next_page = 4 from claim_kommo_backfill('lead_positions', 150, true)));

-- 6) Huecos: 'done' hace > 1 h con un lead sin pipeline → reabre; marcado missing → no.
update kommo_backfill set status='done', lease_until=null, finished_at=now() - interval '2 hours', updated_at=now() - interval '2 hours' where job='lead_positions';
insert into leads (kommo_lead_id, created_at) values (101, now() - interval '3 hours');
select pg_temp.expect('hueco real reabre el recorrido',
  (select outcome from claim_kommo_backfill('lead_positions', 150, false, 900, true)) = 'restarted');
update kommo_backfill set status='done', lease_until=null, finished_at=now() - interval '2 hours', updated_at=now() - interval '2 hours' where job='lead_positions';
update leads set kommo_missing_at = now() where kommo_lead_id = 101;
select pg_temp.expect('lead marcado inexistente NO reabre',
  (select outcome from claim_kommo_backfill('lead_positions', 150, false, 900, true)) = 'done');
update leads set kommo_missing_at = null, kommo_pipeline_id = 1 where kommo_lead_id = 101;
select pg_temp.expect('lead con pipeline NO reabre',
  (select outcome from claim_kommo_backfill('lead_positions', 150, false, 900, true)) = 'done');
update kommo_backfill set finished_at = now() - interval '10 minutes' where job='lead_positions';
update leads set kommo_pipeline_id = null where kommo_lead_id = 101;
select pg_temp.expect('hueco pero terminó hace < 1 h NO reabre',
  (select outcome from claim_kommo_backfill('lead_positions', 150, false, 900, true)) = 'done');

-- 7) Recorrido completo: marca solo los no vistos, creados antes del inicio.
delete from leads where true;
insert into leads (kommo_lead_id, created_at, kommo_pipeline_id, kommo_stage_id) values
  (1, now() - interval '5 days', 1, 10),   -- visto
  (2, now() - interval '5 days', 1, 10),   -- borrado en Kommo (con pipeline viejo)
  (3, now() - interval '5 days', null, null), -- borrado, nunca tuvo pipeline
  (4, now() + interval '1 hour', null, null); -- nace "después" del inicio: no se marca
update kommo_backfill set status='done', lease_until=null, finished_at=now() - interval '1 hour', updated_at=now() - interval '1 hour' where job='lead_positions';
select outcome from claim_kommo_backfill('lead_positions', 150, true);  -- restarted: vacía lo visto, started_at = now()
-- (el lead 4 se creó "en el futuro" respecto de started_at, equivale a nacer durante el recorrido)
select pg_temp.expect('sin hojas vistas no marca nada', mark_kommo_missing_leads('lead_positions') = 0);
select apply_kommo_lead_positions('[{"id":1,"pipeline_id":2,"status_id":20}]'::jsonb);
select pg_temp.expect('apply actualiza el lead visto', (select kommo_pipeline_id = 2 and kommo_stage_id = 20 from leads where kommo_lead_id = 1));
select pg_temp.expect('mark marca exactamente 2 (el 2 y el 3)', mark_kommo_missing_leads('lead_positions') = 2);
select pg_temp.expect('2 y 3 quedan marcados; 1 y 4 no',
  (select count(*) filter (where kommo_missing_at is not null) = 2
      and bool_and((kommo_missing_at is not null) = (kommo_lead_id in (2,3))) from leads));
select pg_temp.expect('mark es idempotente', mark_kommo_missing_leads('lead_positions') = 0);
-- Kommo vuelve a devolver el 2 (restaurado): apply limpia la marca.
select apply_kommo_lead_positions('[{"id":2,"pipeline_id":1,"status_id":10}]'::jsonb);
select pg_temp.expect('volver a verlo limpia la marca', (select kommo_missing_at is null from leads where kommo_lead_id = 2));

-- 8) Un nuevo recorrido (página 1) vacía lo visto.
update kommo_backfill set status='done', lease_until=null, updated_at=now() - interval '1 hour', finished_at=now() - interval '1 hour' where job='lead_positions';
select outcome from claim_kommo_backfill('lead_positions', 150, true);
select pg_temp.expect('restart vacía kommo_backfill_seen', (select count(*) from kommo_backfill_seen) = 0);

-- 9) Freno de pipelines en la base.
delete from kommo_sync_state where true;
select pg_temp.expect('primer refresco: gana', claim_kommo_pipelines_refresh(30));
select pg_temp.expect('segundo inmediato: frenado', not claim_kommo_pipelines_refresh(30));
update kommo_sync_state set last_at = now() - interval '31 seconds';
select pg_temp.expect('pasados 30 s: gana otra vez', claim_kommo_pipelines_refresh(30));

-- 10) Permisos: solo service_role.
select pg_temp.expect('anon/authenticated no ejecutan claim/mark/refresh',
  not has_function_privilege('anon', 'claim_kommo_backfill(text,int,boolean,int,boolean,int)', 'execute')
  and not has_function_privilege('authenticated', 'claim_kommo_backfill(text,int,boolean,int,boolean,int)', 'execute')
  and not has_function_privilege('authenticated', 'mark_kommo_missing_leads(text)', 'execute')
  and not has_function_privilege('authenticated', 'claim_kommo_pipelines_refresh(int)', 'execute')
  and has_function_privilege('service_role', 'claim_kommo_pipelines_refresh(int)', 'execute'));

rollback;
