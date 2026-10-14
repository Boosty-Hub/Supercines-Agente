-- Prueba de la migración 0079: la RLS distingue alcances; secretos y config solo por el servidor.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/runtime_config_lockdown.sql
-- Matriz verificada (tabla × alcance) = la de CLAUDE.md «Quién entra y hasta dónde».
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
select pg_temp.expect('configuracion/admin/sin rol SÍ cambian los switches',
  (select bool_and(pg_temp.run_as(k, 'update kommo_publish_config set notes = ''zz''') >= 1)
     from jwt where k in ('configuracion', 'admin', 'sin rol')));

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
select pg_temp.expect('operacion SÍ reconoce una alerta',
  pg_temp.run_as('operacion', 'update alerts set acknowledged_at = now() where title = ''zz alerta''') = 1);
select pg_temp.expect('operacion NO reescribe el contenido ni el estado del webhook',
  pg_temp.run_as('operacion', 'update alerts set title = ''x'' where title = ''zz alerta''') = -1
  and pg_temp.run_as('operacion', 'update alerts set webhook_posted_at = null') = -1);
select pg_temp.expect('nadie con sesión inserta ni borra alertas',
  (select bool_and(pg_temp.run_as(k, 'insert into alerts (kind, title) values (''draft_failed'', ''x'')') = -1
               and pg_temp.run_as(k, 'delete from alerts') = -1) from jwt));

-- ── system_incidents: lectura todos, silenciar solo configuracion ────────────────
select pg_temp.expect('operacion lee incidentes (banner)', pg_temp.run_as('operacion', 'select * from system_incidents') >= 1);
select pg_temp.expect('operacion NO silencia incidentes',
  pg_temp.run_as('operacion', 'update system_incidents set muted_until = now() + interval ''1 hour'' where kind = ''zz_test''') <= 0);
select pg_temp.expect('configuracion SÍ silencia incidentes',
  pg_temp.run_as('configuracion', 'update system_incidents set muted_until = now() + interval ''1 hour'' where kind = ''zz_test''') = 1);
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

rollback;
