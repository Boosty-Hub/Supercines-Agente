-- Prueba de la migración 0080 (tablas propias de SuperCines): matriz tabla × alcance, FAIL-CLOSED
-- (sin rol = sin acceso, igual que 0079 y getScope).
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/supercines_table_scopes.sql   (DESDE EL ARCHIVO: usa \ir)
-- También prueba que 0076 + 0081 llevan la config REAL de producción de SuperCines (los 4 tipos
-- del default viejo) al conjunto completo de tipos notificables.
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- JWT por alcance (la misma forma que manda GoTrue: app_metadata.role).
create temp table jwt (k text primary key, claims text not null);
insert into jwt values
  ('operacion',     '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"operacion"}}'),
  ('contenido',     '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"contenido"}}'),
  ('editor',        '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"editor"}}'),
  ('corrupto',      '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"Admin "}}'),
  ('configuracion', '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"configuracion"}}'),
  ('admin',         '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"admin"}}'),
  ('sin rol',       '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111","app_metadata":{}}');
grant select on jwt to public;

-- Corre p_sql como `authenticated` con el JWT del alcance (o como p_role si se pasa) y devuelve
-- las filas afectadas/leídas; -1 si la base lo rechazó (sin privilegio / RLS en el insert).
create or replace function pg_temp.run_as(p_scope text, p_sql text, p_role text default 'authenticated')
returns int language plpgsql as $$
declare v_n int := 0;
begin
  perform set_config('request.jwt.claims', coalesce((select claims from jwt where k = p_scope), ''), true);
  execute format('set local role %I', p_role);
  begin
    if p_sql ~* '^\s*select' then
      execute format('select count(*) from (%s) q', p_sql) into v_n;
    else
      execute p_sql;
      get diagnostics v_n = row_count;
    end if;
  exception when insufficient_privilege or others then
    v_n := -1;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v_n;
end $$;
grant execute on function pg_temp.run_as(text, text, text) to public;


-- Datos de prueba (como dueño).
insert into routing_assignees (kommo_user_id, display_name) values (990001, 'zz asesor');
insert into salesbot_funnel_leads (kommo_lead_id, sede, flow_type, kommo_created_at) values (990001, 'caracas', 'cumpleanos', now());
insert into routing_state (key, last_user_id) values ('zz', 1) on conflict do nothing;

-- routing_assignees: solo configuracion (lectura y escritura).
select pg_temp.expect('routing_assignees: configuracion/admin leen; el resto (incluido sin rol) no ve nada',
  pg_temp.run_as('configuracion', 'select 1 from routing_assignees') >= 1
  and pg_temp.run_as('admin', 'select 1 from routing_assignees') >= 1
  and pg_temp.run_as('sin rol', 'select 1 from routing_assignees') = 0
  and pg_temp.run_as('contenido', 'select 1 from routing_assignees') = 0
  and pg_temp.run_as('operacion', 'select 1 from routing_assignees') = 0
  and pg_temp.run_as('corrupto', 'select 1 from routing_assignees') = 0);
select pg_temp.expect('routing_assignees: solo configuracion escribe',
  pg_temp.run_as('configuracion', $$update routing_assignees set display_name = 'zz2' where kommo_user_id = 990001$$) = 1
  and pg_temp.run_as('contenido', $$update routing_assignees set display_name = 'zz3' where kommo_user_id = 990001$$) <= 0
  and pg_temp.run_as('operacion', $$delete from routing_assignees where kommo_user_id = 990001$$) <= 0
  and pg_temp.run_as('sin rol', $$update routing_assignees set display_name = 'zz4' where kommo_user_id = 990001$$) <= 0);
select pg_temp.expect('routing_assignees: ni truncate ni references para authenticated',
  not has_table_privilege('authenticated', 'routing_assignees', 'truncate')
  and not has_table_privilege('authenticated', 'routing_assignees', 'references'));
select pg_temp.expect('routing_assignees: anon sin privilegio', pg_temp.run_as('configuracion', 'select 1 from routing_assignees', 'anon') = -1);

-- routing_state: solo servidor.
select pg_temp.expect('routing_state: ni authenticated ni anon',
  pg_temp.run_as('configuracion', 'select 1 from routing_state') = -1
  and pg_temp.run_as('admin', 'update routing_state set last_user_id = 2') = -1
  and pg_temp.run_as('configuracion', 'select 1 from routing_state', 'anon') = -1);

-- salesbot_funnel_leads: leer contenido+, nunca escribir.
select pg_temp.expect('salesbot_funnel_leads: contenido+ lee; operacion no',
  pg_temp.run_as('contenido', 'select 1 from salesbot_funnel_leads') >= 1
  and pg_temp.run_as('editor', 'select 1 from salesbot_funnel_leads') >= 1
  and pg_temp.run_as('configuracion', 'select 1 from salesbot_funnel_leads') >= 1
  and pg_temp.run_as('operacion', 'select 1 from salesbot_funnel_leads') = 0);
select pg_temp.expect('salesbot_funnel_leads: ningun alcance escribe',
  pg_temp.run_as('configuracion', $$delete from salesbot_funnel_leads where kommo_lead_id = 990001$$) = -1
  and pg_temp.run_as('admin', $$update salesbot_funnel_leads set sede = 'x'$$) = -1);

-- lead_routing_events: operacion+ lee (sin rol no), nadie escribe desde la sesion.
insert into lead_routing_events (kommo_lead_id, strategy) values (990001, 'skipped');
select pg_temp.expect('lead_routing_events: operacion+ lee, sin rol no; escritura negada a todos',
  pg_temp.run_as('operacion', 'select 1 from lead_routing_events') >= 1
  and pg_temp.run_as('sin rol', 'select 1 from lead_routing_events') = 0
  and pg_temp.run_as('configuracion', $$delete from lead_routing_events$$) = -1
  and pg_temp.run_as('configuracion', $$insert into lead_routing_events (kommo_lead_id, strategy) values (990001, 'skipped')$$) = -1
  and pg_temp.run_as('configuracion', 'select 1 from lead_routing_events', 'anon') = -1);
-- lead_stage_events (de 0079): 0080 no la reabre (sin rol sigue sin verla).
select pg_temp.expect('lead_stage_events: sin rol no la ve y nadie borra desde la sesion',
  pg_temp.run_as('sin rol', 'select 1 from lead_stage_events') = 0
  and pg_temp.run_as('configuracion', $$delete from lead_stage_events$$) = -1);

-- ── Config REAL de producción: los 4 tipos del default viejo → 0076 + 0081 la completan ───────
insert into alert_config (is_active) select true where not exists (select 1 from alert_config where is_active);
update alert_config set webhook_kinds = array['draft_failed','human_review_needed','outcomes_regression','inbound_silence']::text[] where is_active;
\ir ../migrations/0076_alert_webhook_delivery.sql
\ir ../migrations/0081_supercines_alert_kinds_existing_config.sql
\ir ../migrations/0081_supercines_alert_kinds_existing_config.sql
select pg_temp.expect('config real de produccion: queda con TODOS los tipos notificables, una vez cada uno',
  (select (select array_agg(k order by k) from unnest(webhook_kinds) k) = array[
     'budget_exceeded','cola_atascada','draft_failed','human_review_needed','inbound_dropped','inbound_silence',
     'ingesta_detenida','kommo_token','kommo_webhook_caido','kommo_webhook_disabled','outbound_blocked',
     'outcomes_regression','provider_credit_exhausted','registro_abierto','salesbot_not_delivered','webhook_rejected','webhook_unsigned']::text[]
     from alert_config where is_active));

rollback;
