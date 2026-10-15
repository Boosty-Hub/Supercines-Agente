-- Prueba de la migración 0079: la RLS distingue alcances y cae cerrada; secretos y config solo
-- por el servidor; datos operativos sin borrado y con escritura por columna.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/runtime_config_lockdown.sql   (ver supabase/tests/README.md)
-- Matriz verificada (tabla × alcance) = la de CLAUDE.md «Quién entra y hasta dónde».
-- «sin rol» (app_metadata.role ausente) = SIN ACCESO: no está en ninguna lista de «SÍ».
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
  ('sin rol',       '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111","app_metadata":{}}'),
  ('rol null',      '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":null}}'),
  ('rol no texto',  '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":["configuracion"]}}'),
  ('sin app_meta',  '{"role":"authenticated","sub":"11111111-1111-1111-1111-111111111111"}');
grant select on jwt to public;

-- Usuarios reales (las columnas *_by / reviewer_id tienen FK a auth.users): así un rechazo es de
-- la policy, no de la FK.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'zz-uno@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'zz-dos@test.local')
  on conflict (id) do nothing;

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
insert into runtime_config (key, value) values ('ZZ_TEST_SECRET', 'sk-ant-zz-no-debe-verse-1234')
  on conflict (key) do update set value = excluded.value;
insert into kommo_publish_config (is_active) select true where not exists (select 1 from kommo_publish_config where is_active);
insert into follow_up_config (is_active) select true where not exists (select 1 from follow_up_config where is_active);
insert into alert_config (is_active, webhook_url) select true, 'https://hooks.slack.com/services/zz' where not exists (select 1 from alert_config where is_active);
insert into usage_events (component, model, estimated_cost_usd) values ('zz_test', 'claude-haiku-5-5', 0.01);
insert into alerts (kind, title) values ('draft_failed', 'zz alerta');
insert into system_incidents (kind, title) values ('zz_test', 'zz incidente');
insert into kommo_credentials (subdomain, client_id, encrypted_access_token, token_expires_at, is_active)
  select 'zz', 'zz', 'token-secreto', now() + interval '1 day', false;

-- ── runtime_config: NADIE con sesión ni anon ─────────────────────────────────────
create temp table res (k text, n int);
grant all on res to public;
insert into res select 'rc_select:' || k, pg_temp.run_as(k, 'select * from runtime_config') from jwt;
insert into res select 'rc_secret:' || k, pg_temp.run_as(k, 'select value from runtime_config where key = ''ZZ_TEST_SECRET''') from jwt;
insert into res select 'rc_update:' || k, pg_temp.run_as(k, 'update runtime_config set value = ''x'' where key = ''ZZ_TEST_SECRET''') from jwt;
insert into res select 'rc_insert:' || k, pg_temp.run_as(k, 'insert into runtime_config (key, value) values (''ZZ_EVIL'', ''x'')') from jwt;
insert into res select 'rc_delete:' || k, pg_temp.run_as(k, 'delete from runtime_config') from jwt;
select pg_temp.expect('ningún alcance LEE runtime_config (ni el de configuracion: el panel lee por el servidor)',
  (select bool_and(n = -1) from res where k like 'rc_select:%' or k like 'rc_secret:%'));
select pg_temp.expect('ningún alcance ESCRIBE runtime_config',
  (select bool_and(n = -1) from res where k like 'rc_update:%' or k like 'rc_insert:%' or k like 'rc_delete:%'));
select pg_temp.expect('el secreto sigue intacto',
  (select value = 'sk-ant-zz-no-debe-verse-1234' from runtime_config where key = 'ZZ_TEST_SECRET'));
select pg_temp.expect('anon no lee runtime_config', pg_temp.run_as('anon', 'select * from runtime_config', 'anon') = -1);
select pg_temp.expect('anon no escribe runtime_config',
  pg_temp.run_as('anon', 'insert into runtime_config (key, value) values (''ZZ_EVIL'', ''x'')', 'anon') = -1);
select pg_temp.expect('authenticated/anon sin privilegio de tabla sobre runtime_config',
  not has_table_privilege('authenticated', 'runtime_config', 'select')
  and not has_table_privilege('authenticated', 'runtime_config', 'update')
  and not has_table_privilege('anon', 'runtime_config', 'select'));
select pg_temp.expect('runtime_config sin policies para authenticated/anon (RLS habilitada)',
  (select relrowsecurity from pg_class where oid = 'runtime_config'::regclass)
  and not exists (select 1 from pg_policy where polrelid = 'runtime_config'::regclass));
select pg_temp.expect('service_role SÍ lee runtime_config',
  pg_temp.run_as('', 'select * from runtime_config where key = ''ZZ_TEST_SECRET''', 'service_role') = 1);
select pg_temp.expect('service_role SÍ escribe runtime_config',
  pg_temp.run_as('', 'update runtime_config set updated_by = ''test'' where key = ''ZZ_TEST_SECRET''', 'service_role') = 1);

-- ── Solo servidor: kommo_credentials, alert_config, _migrations ──────────────────
select pg_temp.expect('ningún alcance lee kommo_credentials (tokens)',
  (select bool_and(pg_temp.run_as(k, 'select * from kommo_credentials') = -1) from jwt));
select pg_temp.expect('ningún alcance lee alert_config (webhook_url es un secreto)',
  (select bool_and(pg_temp.run_as(k, 'select webhook_url from alert_config') = -1) from jwt));
select pg_temp.expect('ningún alcance escribe alert_config',
  (select bool_and(pg_temp.run_as(k, 'update alert_config set webhook_url = ''https://evil.example''') = -1) from jwt));
select pg_temp.expect('_migrations: ni authenticated ni anon (marcar una migración como aplicada la saltearía)',
  not has_table_privilege('authenticated', '_migrations', 'insert')
  and not has_table_privilege('anon', '_migrations', 'select'));

-- ── anon: nada sobre ninguna tabla/vista de public ───────────────────────────────
select pg_temp.expect('anon sin SELECT/INSERT/UPDATE/DELETE en ninguna tabla o vista de public',
  not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
       and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
       and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
         or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))));
select pg_temp.expect('toda tabla de public tiene RLS habilitada',
  not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
       and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')));

-- ── kommo_publish_config: lectura todos, escritura configuracion ─────────────────
select pg_temp.expect('operacion LEE kommo_publish_config (inbox)',
  pg_temp.run_as('operacion', 'select * from kommo_publish_config') >= 1);
select pg_temp.expect('operacion/contenido/editor/corrupto NO cambian los switches',
  (select bool_and(pg_temp.run_as(k, 'update kommo_publish_config set agent_enabled = not agent_enabled') <= 0)
     from jwt where k in ('operacion', 'contenido', 'editor', 'corrupto')));
select pg_temp.expect('configuracion/admin SÍ cambian los switches',
  (select bool_and(pg_temp.run_as(k, 'update kommo_publish_config set notes = ''zz''') >= 1)
     from jwt where k in ('configuracion', 'admin')));
select pg_temp.expect('sin rol (o rol null / no texto / sin app_metadata) NO lee ni cambia los switches (fail-closed)',
  (select bool_and(pg_temp.run_as(k, 'select * from kommo_publish_config') = 0
               and pg_temp.run_as(k, 'update kommo_publish_config set notes = ''zz''') <= 0)
     from jwt where k in ('sin rol', 'rol null', 'rol no texto', 'sin app_meta')));

-- ── follow_up_config: lectura contenido+, escritura configuracion ────────────────
select pg_temp.expect('operacion NO lee follow_up_config', pg_temp.run_as('operacion', 'select * from follow_up_config') = 0);
select pg_temp.expect('contenido SÍ lee follow_up_config (/consumo)', pg_temp.run_as('contenido', 'select * from follow_up_config') >= 1);
select pg_temp.expect('contenido NO escribe follow_up_config',
  pg_temp.run_as('contenido', 'update follow_up_config set notes = ''zz''') <= 0);
select pg_temp.expect('configuracion SÍ escribe follow_up_config',
  pg_temp.run_as('configuracion', 'update follow_up_config set notes = ''zz''') >= 1);

-- ── Solo configuracion: agent_skip_rules, follow_up_fields/templates/steps ──────
select pg_temp.expect('contenido NO crea reglas de salto',
  pg_temp.run_as('contenido', 'insert into agent_skip_rules (pattern) values (''zz'')') = -1);
select pg_temp.expect('configuracion SÍ crea reglas de salto',
  pg_temp.run_as('configuracion', 'insert into agent_skip_rules (pattern) values (''zz'')') = 1);
select pg_temp.expect('contenido NO lee reglas de salto',
  pg_temp.run_as('contenido', 'select * from agent_skip_rules') = 0);
select pg_temp.expect('configuracion SÍ crea plantillas de seguimiento',
  pg_temp.run_as('configuracion', 'insert into follow_up_templates (name, body) values (''zz'', ''zz'')') = 1);
select pg_temp.expect('operacion y contenido NO leen ni crean plantillas de seguimiento',
  pg_temp.run_as('operacion', 'select * from follow_up_templates') = 0
  and pg_temp.run_as('contenido', 'select * from follow_up_templates') = 0
  and pg_temp.run_as('contenido', 'insert into follow_up_templates (name, body) values (''zz'', ''zz'')') = -1);

-- ── Contenido+: graders, promotions, situations, kb, voz, memory_items ───────────
select pg_temp.expect('operacion NO lee ni crea graders',
  pg_temp.run_as('operacion', 'select * from graders') = 0
  and pg_temp.run_as('operacion', 'insert into graders (slug, name, prompt) values (''zz_op'', ''zz'', ''zz'')') = -1);
select pg_temp.expect('contenido y editor SÍ crean graders',
  pg_temp.run_as('contenido', 'insert into graders (slug, name, prompt) values (''zz_co'', ''zz'', ''zz'')') = 1
  and pg_temp.run_as('editor', 'insert into graders (slug, name, prompt) values (''zz_ed'', ''zz'', ''zz'')') = 1);
select pg_temp.expect('un rol irreconocible NO crea promos (cae cerrado)',
  pg_temp.run_as('corrupto', 'insert into promotions (name, content) values (''zz'', ''zz'')') = -1);
select pg_temp.expect('contenido SÍ crea promos',
  pg_temp.run_as('contenido', 'insert into promotions (name, content) values (''zz'', ''zz'')') = 1);

-- ── verticals: lectura todos (inbox), escritura contenido+ ───────────────────────
select pg_temp.expect('operacion SÍ lee verticales', pg_temp.run_as('operacion', 'select * from verticals') >= 1);
select pg_temp.expect('operacion NO crea verticales',
  pg_temp.run_as('operacion', 'insert into verticals (slug, name, system_prompt) values (''zz_op'', ''zz'', ''zz'')') = -1);
select pg_temp.expect('contenido SÍ crea verticales',
  pg_temp.run_as('contenido', 'insert into verticals (slug, name, system_prompt) values (''zz_co'', ''zz'', ''zz'')') = 1);

-- ── usage_events y vistas: lectura contenido+, sin escritura ─────────────────────
select pg_temp.expect('operacion NO lee consumo (tabla ni vistas)',
  pg_temp.run_as('operacion', 'select * from usage_events') = 0
  and pg_temp.run_as('operacion', 'select * from usage_daily') = 0
  and pg_temp.run_as('operacion', 'select * from usage_hourly_heatmap') = 0);
select pg_temp.expect('contenido SÍ lee consumo', pg_temp.run_as('contenido', 'select * from usage_events') >= 1);
select pg_temp.expect('nadie con sesión inserta usage_events',
  (select bool_and(pg_temp.run_as(k, 'insert into usage_events (component, model) values (''zz'', ''zz'')') = -1) from jwt));

-- ── alerts: leer y reconocer todos; nada más ─────────────────────────────────────
select pg_temp.expect('operacion SÍ reconoce una alerta a nombre propio',
  pg_temp.run_as('operacion', 'update alerts set acknowledged_at = now(), acknowledged_by = ''11111111-1111-1111-1111-111111111111'' where title = ''zz alerta''') = 1);
select pg_temp.expect('nadie reconoce una alerta a nombre de OTRO ni sin firmar',
  pg_temp.run_as('operacion', 'update alerts set acknowledged_at = now(), acknowledged_by = ''22222222-2222-2222-2222-222222222222'' where title = ''zz alerta''') = -1
  and pg_temp.run_as('configuracion', 'update alerts set acknowledged_at = now(), acknowledged_by = null where title = ''zz alerta''') = -1);
select pg_temp.expect('la alerta sigue reconocida por quien la reconoció',
  (select acknowledged_by = '11111111-1111-1111-1111-111111111111' from alerts where title = 'zz alerta'));
select pg_temp.expect('sin rol NO lee ni reconoce alertas',
  pg_temp.run_as('sin rol', 'select * from alerts') = 0
  and pg_temp.run_as('sin rol', 'update alerts set acknowledged_at = now(), acknowledged_by = ''11111111-1111-1111-1111-111111111111''') <= 0);
select pg_temp.expect('operacion NO reescribe el contenido ni el estado del webhook',
  pg_temp.run_as('operacion', 'update alerts set title = ''x'' where title = ''zz alerta''') = -1
  and pg_temp.run_as('operacion', 'update alerts set webhook_posted_at = null') = -1);
select pg_temp.expect('nadie con sesión inserta ni borra alertas',
  (select bool_and(pg_temp.run_as(k, 'insert into alerts (kind, title) values (''draft_failed'', ''x'')') = -1
               and pg_temp.run_as(k, 'delete from alerts') = -1) from jwt));

-- ── system_incidents: lectura todos, silenciar solo configuracion ────────────────
select pg_temp.expect('operacion lee incidentes (banner)', pg_temp.run_as('operacion', 'select * from system_incidents') >= 1);
select pg_temp.expect('sin rol NO lee incidentes', pg_temp.run_as('sin rol', 'select * from system_incidents') = 0);
select pg_temp.expect('operacion NO silencia incidentes',
  pg_temp.run_as('operacion', 'update system_incidents set muted_until = now() + interval ''1 hour'' where kind = ''zz_test''') <= 0);
select pg_temp.expect('configuracion SÍ silencia incidentes a nombre propio',
  pg_temp.run_as('configuracion', 'update system_incidents set muted_until = now() + interval ''1 hour'', muted_by = ''11111111-1111-1111-1111-111111111111'' where kind = ''zz_test''') = 1);
select pg_temp.expect('configuracion NO silencia a nombre de otro',
  pg_temp.run_as('configuracion', 'update system_incidents set muted_until = now() + interval ''2 hour'', muted_by = ''22222222-2222-2222-2222-222222222222'' where kind = ''zz_test''') = -1);
select pg_temp.expect('configuracion NO los da por resueltos (eso es del health-scan)',
  pg_temp.run_as('configuracion', 'update system_incidents set resolved_at = now() where kind = ''zz_test''') = -1);

-- ── follow_ups: solo lectura ─────────────────────────────────────────────────────
select pg_temp.expect('nadie con sesión escribe follow_ups',
  not has_table_privilege('authenticated', 'follow_ups', 'insert')
  and not has_table_privilege('authenticated', 'follow_ups', 'delete'));

-- ── gasto_mes_actual lee runtime_config: solo service_role ───────────────────────
select pg_temp.expect('authenticated NO ejecuta gasto_mes_actual (el panel la llama por el servidor)',
  not has_function_privilege('authenticated', 'gasto_mes_actual()', 'execute'));
select pg_temp.expect('service_role SÍ ejecuta gasto_mes_actual',
  pg_temp.run_as('', 'select gasto_mes_actual()', 'service_role') = 1);

-- ── Datos operativos (W4): lectura operacion+, sin borrado, escritura por columna ──
insert into leads (id, kommo_lead_id, display_name) values ('00000000-0000-0000-0000-0000000e0001', 990001, 'zz lead');
insert into messages (id, lead_id, direction, content) values
  ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e0001', 'inbound', 'zz hola');
insert into drafts (id, message_id, body, status) values
  ('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-0000000e0002', 'zz pendiente', 'pending'),
  ('00000000-0000-0000-0000-0000000e0004', '00000000-0000-0000-0000-0000000e0002', 'zz aprobado', 'approved'),
  ('00000000-0000-0000-0000-0000000e0005', '00000000-0000-0000-0000-0000000e0002', 'zz enviado', 'sent');
insert into outcomes (draft_id, grader_id)
  select '00000000-0000-0000-0000-0000000e0005', id from graders limit 1;
insert into lead_stage_events (lead_id, to_stage_id, moved_by) values ('00000000-0000-0000-0000-0000000e0001', 10, 'kommo');
insert into inbound_queue (payload, status, created_at) values ('{"zz": true}', 'processing', now() - interval '2 hours');
insert into follow_ups (lead_id, step, status) values ('00000000-0000-0000-0000-0000000e0001', 1, 'sent');
insert into kommo_pipelines (id, name) values (990001, 'zz pipeline') on conflict do nothing;
insert into kommo_stages (pipeline_id, id, name) values (990001, 990010, 'zz etapa') on conflict do nothing;
insert into kb_documents (id, title, source_type) values ('00000000-0000-0000-0000-0000000e0006', 'zz doc', 'text');
insert into kb_chunks (document_id, chunk_index, content) values ('00000000-0000-0000-0000-0000000e0006', 0, 'zz');
insert into situations (title, content) values ('zz', 'zz');
insert into voice_samples (type, title, content) values ('rule', 'zz', 'zz');
insert into memory_items (store_name, source_kind, content) values ('master', 'zz', 'zz');
insert into follow_up_fields (label, kommo_field_id) values ('zz', 990001);
insert into follow_up_steps (step_number, delay_hours) values (99, 1);
insert into follow_up_templates (name, body) values ('zz seed', 'zz');
insert into agent_skip_rules (pattern) values ('zz seed');
insert into promotions (name, content) values ('zz seed', 'zz');

select pg_temp.expect('operacion LEE el inbox: leads, messages, drafts, outcomes, eventos, follow_ups, pipelines, etapas, estado del webhook y del recorrido',
  pg_temp.run_as('operacion', 'select * from leads') >= 1
  and pg_temp.run_as('operacion', 'select * from messages') >= 1
  and pg_temp.run_as('operacion', 'select * from drafts') >= 3
  and pg_temp.run_as('operacion', 'select * from outcomes') >= 1
  and pg_temp.run_as('operacion', 'select * from lead_stage_events') >= 1
  and pg_temp.run_as('operacion', 'select * from follow_ups') >= 1
  and pg_temp.run_as('operacion', 'select * from kommo_pipelines') >= 1
  and pg_temp.run_as('operacion', 'select * from kommo_stages') >= 1
  and pg_temp.run_as('operacion', 'select * from kommo_webhook_auth') >= 1
  and pg_temp.run_as('operacion', 'select status, scanned, updated, last_error, finished_at, updated_at, lease_until from kommo_backfill') >= 1);
select pg_temp.expect('nadie con sesión lee el token del lease del recorrido',
  (select bool_and(pg_temp.run_as(k, 'select lease_token from kommo_backfill') = -1) from jwt));

select pg_temp.expect('nadie con sesión BORRA datos operativos',
  (select bool_and(
            pg_temp.run_as(k, 'delete from leads') = -1
        and pg_temp.run_as(k, 'delete from messages') = -1
        and pg_temp.run_as(k, 'delete from drafts') = -1
        and pg_temp.run_as(k, 'delete from outcomes') = -1
        and pg_temp.run_as(k, 'delete from lead_stage_events') = -1
        and pg_temp.run_as(k, 'delete from follow_ups') = -1
        and pg_temp.run_as(k, 'delete from kommo_stages') = -1) from jwt));
select pg_temp.expect('nadie con sesión INSERTA datos operativos (leads, mensajes, drafts, outcomes, eventos)',
  (select bool_and(
            pg_temp.run_as(k, 'insert into leads (kommo_lead_id) values (990002)') = -1
        and pg_temp.run_as(k, 'insert into messages (lead_id, direction, content) values (''00000000-0000-0000-0000-0000000e0001'', ''outbound'', ''x'')') = -1
        and pg_temp.run_as(k, 'insert into drafts (message_id, body, status) values (''00000000-0000-0000-0000-0000000e0002'', ''x'', ''approved'')') = -1
        and pg_temp.run_as(k, 'insert into lead_stage_events (lead_id, to_stage_id, moved_by) values (''00000000-0000-0000-0000-0000000e0001'', 1, ''agente'')') = -1) from jwt));
select pg_temp.expect('nadie con sesión edita leads (la etapa va por apply_lead_position con service_role)',
  (select bool_and(pg_temp.run_as(k, 'update leads set display_name = ''x''') = -1) from jwt));

-- inbound_queue: solo servidor (payloads crudos; omitir atascados = /api/incidents/skip-queue).
select pg_temp.expect('nadie con sesión lee ni toca inbound_queue (tampoco configuracion: skip-queue va por el servidor)',
  (select bool_and(pg_temp.run_as(k, 'select * from inbound_queue') = -1
               and pg_temp.run_as(k, 'update inbound_queue set status = ''failed'' where status = ''processing''') = -1
               and pg_temp.run_as(k, 'insert into inbound_queue (payload) values (''{}'')') = -1
               and pg_temp.run_as(k, 'delete from inbound_queue') = -1) from jwt));
select pg_temp.expect('service_role SÍ omite los atascados',
  pg_temp.run_as('', 'update inbound_queue set status = ''failed'' where status = ''processing'' and payload ? ''zz''', 'service_role') = 1);

-- messages: solo la marca de revisión humana.
select pg_temp.expect('operacion marca/desmarca revisión humana',
  pg_temp.run_as('operacion', 'update messages set requires_human_review = false where id = ''00000000-0000-0000-0000-0000000e0002''') = 1
  and pg_temp.run_as('operacion', 'update messages set requires_human_review = true where id = ''00000000-0000-0000-0000-0000000e0002''') = 1);
select pg_temp.expect('nadie reescribe el contenido ni la dirección de un mensaje',
  (select bool_and(pg_temp.run_as(k, 'update messages set content = ''x''') = -1
               and pg_temp.run_as(k, 'update messages set direction = ''outbound''') = -1) from jwt));

-- drafts: aprobar (con edición) / rechazar a nombre propio, solo desde pending/approved.
select pg_temp.expect('operacion aprueba un pending con su texto editado, a nombre propio',
  pg_temp.run_as('operacion', 'update drafts set status = ''approved'', edited_body = ''zz editado'', reviewer_id = ''11111111-1111-1111-1111-111111111111'' where id = ''00000000-0000-0000-0000-0000000e0003''') = 1);
select pg_temp.expect('operacion rechaza un approved (todavía no reservado)',
  pg_temp.run_as('operacion', 'update drafts set status = ''rejected'', reviewer_id = ''11111111-1111-1111-1111-111111111111'' where id = ''00000000-0000-0000-0000-0000000e0004''') = 1);
select pg_temp.expect('nadie marca un draft como enviado/fallido/publishing por PostgREST',
  (select bool_and(pg_temp.run_as(k, format('update drafts set status = %L, reviewer_id = %L where id = %L',
      s, '11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000e0003')) <= 0)
     from jwt, unnest(array['sent', 'auto_sent', 'publishing', 'failed', 'pending']) s));
select pg_temp.expect('nadie aprueba a nombre de otro',
  pg_temp.run_as('operacion', 'update drafts set status = ''approved'', reviewer_id = ''22222222-2222-2222-2222-222222222222'' where id = ''00000000-0000-0000-0000-0000000e0003''') = -1);
select pg_temp.expect('nadie toca el body original ni las columnas de la reserva',
  (select bool_and(pg_temp.run_as(k, 'update drafts set body = ''x''') = -1
               and pg_temp.run_as(k, 'update drafts set publish_owner = null') = -1
               and pg_temp.run_as(k, 'update drafts set sent_at = now()') = -1) from jwt));
select pg_temp.expect('un draft ya enviado no se re-aprueba ni se rechaza desde el panel (0 filas)',
  (select bool_and(pg_temp.run_as(k, 'update drafts set status = ''approved'', reviewer_id = ''11111111-1111-1111-1111-111111111111'' where id = ''00000000-0000-0000-0000-0000000e0005''') <= 0) from jwt));
select pg_temp.expect('estado final de los drafts de prueba',
  (select status = 'approved' and edited_body = 'zz editado' from drafts where id = '00000000-0000-0000-0000-0000000e0003')
  and (select status = 'rejected' from drafts where id = '00000000-0000-0000-0000-0000000e0004')
  and (select status = 'sent' from drafts where id = '00000000-0000-0000-0000-0000000e0005'));

-- Datos sembrados de las tablas propias de SuperCines (0080), para que el «0 filas» no sea trivial.
insert into routing_assignees (kommo_user_id, display_name) values (990001, 'zz asesor');
insert into routing_state (key, last_user_id) values ('zz', 1) on conflict do nothing;
insert into lead_routing_events (kommo_lead_id, strategy) values (990001, 'skipped');
insert into salesbot_funnel_leads (kommo_lead_id, sede, flow_type, kommo_created_at) values (990001, 'caracas', 'cumpleanos', now());

-- ── SIN ROL = SIN ACCESO a NADA (fail-closed, C1) ────────────────────────────────
-- Todas las tablas y vistas de public, con datos sembrados: ni una fila visible ni borrable.
create temp table rels as
  select c.relname::text as rel
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
     and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e');
grant select on rels to public;
create temp table vacias as
  select rel from rels where rel not in ('_migrations')
     and (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I', rel), false, true, '')))[1]::text::int = 0;
-- Lista cerrada: solo pueden quedar vacías las tablas internas de coordinación (solo servidor).
select pg_temp.expect('toda tabla tiene datos sembrados (el «0 filas» no es trivial); vacías fuera de la lista: ' ||
    coalesce((select string_agg(rel, ', ') from vacias
               where rel not in ('kommo_backfill_seen', 'lead_move_claims', 'kommo_sync_state', 'lead_position_seen')), '-'),
  not exists (select 1 from vacias
               where rel not in ('kommo_backfill_seen', 'lead_move_claims', 'kommo_sync_state', 'lead_position_seen')));
select pg_temp.expect('sin rol / rol null / rol no texto / sin app_metadata / rol irreconocible: 0 filas visibles en TODA tabla y vista de public',
  not exists (
    select 1 from rels r cross join jwt j
     where j.k in ('sin rol', 'rol null', 'rol no texto', 'sin app_meta', 'corrupto')
       and pg_temp.run_as(j.k, format('select * from %I', r.rel)) > 0));
select pg_temp.expect('… ni una fila borrable',
  not exists (
    select 1 from rels r cross join jwt j
     where j.k in ('sin rol', 'rol null', 'sin app_meta')
       and r.rel in (select relname::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r')
       and pg_temp.run_as(j.k, format('delete from %I', r.rel)) > 0));

rollback;
