-- =============================================================
-- 0079_runtime_config_lockdown.sql
-- La RLS distingue alcances: los secretos y la configuración dejan de estar abiertos a
-- cualquier sesión por PostgREST.
--
-- PROBLEMA: `runtime_config` (0017) tenía `for all to authenticated using (true)`. Ahí viven en
-- texto plano ANTHROPIC_API_KEY, KOMMO_ACCESS_TOKEN, OPENAI_API_KEY, los TOOL_* de las http
-- tools, SHOPIFY_*, BCV_RATE_APIKEY… Un usuario de alcance `operacion` o `contenido` (que no
-- debe ver credenciales) podía, con su propio JWT y la anon key (pública por diseño), leerlas
-- todas y reescribir la config (SYSTEM_PROMPT, KOMMO_API_DOMAIN, TOOL_X_HOSTS, modelos, techo
-- de gasto…) saltándose el middleware del panel. Lo mismo, en menor medida, con
-- `alert_config.webhook_url` (un secreto: quien lo tiene postea en el canal del operador),
-- `kommo_credentials` (tokens) y las tablas de config que solo edita `configuracion`.
--
-- FIX (mínimo privilegio, matriz completa en CLAUDE.md «Quién entra y hasta dónde»):
--   · Solo servidor (service_role, tras validar sesión + alcance en la ruta): runtime_config,
--     kommo_credentials, alert_config, _migrations. `authenticated` y `anon` sin privilegio de
--     tabla y sin policy (RLS habilitada → negado aunque alguien re-otorgue el GRANT).
--   · Escritura solo `configuracion` (lectura según la vista que la necesita):
--     kommo_publish_config, system_incidents (lectura: todos — banner y switches; de
--     system_incidents solo se edita muted_until/muted_by: silenciar, no resolver),
--     follow_up_config (lectura: contenido+, la usa /consumo), agent_skip_rules,
--     follow_up_fields/templates/steps (lectura y escritura: configuracion).
--   · Contenido+ (lectura y escritura): graders, promotions, situations, kb_documents,
--     kb_chunks, voice_samples, memory_items. verticals: lectura todos (el inbox muestra la
--     vertical), escritura contenido+. usage_events: lectura contenido+, sin escritura (la
--     escriben Edge Functions y /api/usage/backfill con service_role); sus vistas
--     usage_daily / usage_hourly_heatmap pasan a security_invoker (antes corrían como dueño y
--     anon las leía).
--   · alerts: lectura y «reconocer» (update) para todos; insert/delete solo servidor.
--   · Datos operativos (leads, messages, drafts, outcomes, inbound_queue, lead_stage_events):
--     sin cambios (todo alcance atiende el inbox); follow_ups sigue solo lectura (0075).
--   · anon: NINGÚN privilegio sobre tablas, vistas ni secuencias de public (el panel nunca usa
--     el rol anon para datos), también para las futuras (default privileges).
--   · gasto_mes_actual(): lee runtime_config (BUDGET_EXCLUDE_BEFORE) y es SECURITY INVOKER, así
--     que con la sesión ya no puede correr; /consumo la llama con service_role tras validar el
--     alcance → se le quita EXECUTE a authenticated (function_execute.sql lo verifica).
--
-- El alcance sale de `app_metadata.role` del JWT (solo escribible con service_role) con la
-- MISMA regla que web/src/lib/auth/roles.ts#getScope: sin rol (el maestro del first-run) →
-- configuracion; `admin` → configuracion; `editor` → contenido; un valor irreconocible cae
-- CERRADO. La condición va INLINE en cada policy (como en 0078): la RLS evalúa funciones con
-- los permisos del que consulta y `authenticated` no ejecuta funciones de public salvo las del
-- panel. Se arma una sola vez acá y se reparte con format().
--
-- runtime_config.is_secret (0017) queda como dato informativo: NO decide nada (estaba mal
-- marcado en varias claves). La clasificación de secretos del panel es
-- web/src/lib/config-secrets.ts (clave desconocida ⇒ secreta).
--
-- service_role y el dueño bypassean la RLS (Edge Functions, cron, rutas del servidor).
-- IDEMPOTENTE (se puede aplicar dos veces).
-- =============================================================

do $$
declare
  -- claims de la petición (null si no hay JWT: p. ej. una sesión SQL sin request).
  c constant text := $c$nullif(current_setting('request.jwt.claims', true), '')$c$;
  role_absent text;
  cond_config text;
  cond_contenido text;
  t text;
begin
  role_absent := format(
    '(%1$s::jsonb -> ''app_metadata'' -> ''role'') is null or jsonb_typeof(%1$s::jsonb -> ''app_metadata'' -> ''role'') = ''null''',
    c);
  cond_config := format(
    'coalesce(case when %1$s is null then false when %2$s then true '
    'when %1$s::jsonb -> ''app_metadata'' ->> ''role'' in (''admin'', ''configuracion'') then true else false end, false)',
    c, role_absent);
  cond_contenido := format(
    'coalesce(case when %1$s is null then false when %2$s then true '
    'when %1$s::jsonb -> ''app_metadata'' ->> ''role'' in (''admin'', ''configuracion'', ''editor'', ''contenido'') then true else false end, false)',
    c, role_absent);

  -- ── anon: nada sobre tablas/vistas/secuencias de public ──────────────────────
  execute 'revoke all on all tables in schema public from anon';
  execute 'revoke all on all sequences in schema public from anon';
  foreach t in array array[current_user::text, 'postgres', 'supabase_admin'] loop
    if exists (select 1 from pg_roles where rolname = t) then
      begin
        execute format('alter default privileges for role %I in schema public revoke all on tables from anon', t);
        execute format('alter default privileges for role %I in schema public revoke all on sequences from anon', t);
      exception when insufficient_privilege then
        raise notice 'default privileges de % no modificados (sin permiso): ejecutar como ese rol', t;
      end;
    end if;
  end loop;

  -- ── Solo servidor ────────────────────────────────────────────────────────────
  foreach t in array array['runtime_config', 'kommo_credentials', 'alert_config', '_migrations'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table %I enable row level security', t);
      execute format('revoke all on %I from anon, authenticated, public', t);
      execute format('grant all on %I to service_role', t);
    end if;
  end loop;
  drop policy if exists runtime_config_authenticated on runtime_config;
  drop policy if exists authenticated_read on kommo_credentials;
  drop policy if exists authenticated_all on alert_config;

  -- ── Lectura para todos, escritura solo configuracion ─────────────────────────
  foreach t in array array['kommo_publish_config', 'system_incidents'] loop
    execute format('drop policy if exists authenticated_all on %I', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_insert_config', t);
    execute format('drop policy if exists %I on %I', t || '_update_config', t);
    execute format('drop policy if exists %I on %I', t || '_delete_config', t);
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
    execute format('create policy %I on %I for insert to authenticated with check (%s)', t || '_insert_config', t, cond_config);
    execute format('create policy %I on %I for update to authenticated using (%s) with check (%s)', t || '_update_config', t, cond_config, cond_config);
    execute format('create policy %I on %I for delete to authenticated using (%s)', t || '_delete_config', t, cond_config);
    execute format('revoke truncate, references, trigger on %I from authenticated', t);
  end loop;
  -- system_incidents: el panel solo silencia (muted_until/muted_by); insertar, borrar o
  -- «resolver» es del health-scan.
  revoke insert, update, delete on system_incidents from authenticated;
  grant update (muted_until, muted_by) on system_incidents to authenticated;

  -- ── Lectura contenido+, escritura configuracion ──────────────────────────────
  drop policy if exists authenticated_all on follow_up_config;
  drop policy if exists follow_up_config_read on follow_up_config;
  drop policy if exists follow_up_config_insert_config on follow_up_config;
  drop policy if exists follow_up_config_update_config on follow_up_config;
  drop policy if exists follow_up_config_delete_config on follow_up_config;
  execute format('create policy follow_up_config_read on follow_up_config for select to authenticated using (%s)', cond_contenido);
  execute format('create policy follow_up_config_insert_config on follow_up_config for insert to authenticated with check (%s)', cond_config);
  execute format('create policy follow_up_config_update_config on follow_up_config for update to authenticated using (%s) with check (%s)', cond_config, cond_config);
  execute format('create policy follow_up_config_delete_config on follow_up_config for delete to authenticated using (%s)', cond_config);
  revoke truncate, references, trigger on follow_up_config from authenticated;

  -- ── Solo configuracion (lectura y escritura) ─────────────────────────────────
  foreach t in array array['agent_skip_rules', 'follow_up_fields', 'follow_up_templates', 'follow_up_steps'] loop
    execute format('drop policy if exists authenticated_all on %I', t);
    execute format('drop policy if exists %I on %I', t || '_config', t);
    execute format('create policy %I on %I for all to authenticated using (%s) with check (%s)', t || '_config', t, cond_config, cond_config);
    execute format('revoke truncate, references, trigger on %I from authenticated', t);
  end loop;

  -- ── Contenido+ (lectura y escritura) ─────────────────────────────────────────
  foreach t in array array['graders', 'promotions', 'situations', 'kb_documents', 'kb_chunks', 'voice_samples', 'memory_items'] loop
    execute format('drop policy if exists authenticated_all on %I', t);
    execute format('drop policy if exists %I on %I', t || '_contenido', t);
    execute format('create policy %I on %I for all to authenticated using (%s) with check (%s)', t || '_contenido', t, cond_contenido, cond_contenido);
    execute format('revoke truncate, references, trigger on %I from authenticated', t);
  end loop;

  -- ── verticals: lectura todos, escritura contenido+ ───────────────────────────
  drop policy if exists authenticated_all on verticals;
  drop policy if exists verticals_read on verticals;
  drop policy if exists verticals_insert_contenido on verticals;
  drop policy if exists verticals_update_contenido on verticals;
  drop policy if exists verticals_delete_contenido on verticals;
  create policy verticals_read on verticals for select to authenticated using (true);
  execute format('create policy verticals_insert_contenido on verticals for insert to authenticated with check (%s)', cond_contenido);
  execute format('create policy verticals_update_contenido on verticals for update to authenticated using (%s) with check (%s)', cond_contenido, cond_contenido);
  execute format('create policy verticals_delete_contenido on verticals for delete to authenticated using (%s)', cond_contenido);
  revoke truncate, references, trigger on verticals from authenticated;

  -- ── usage_events: lectura contenido+, escritura solo servidor ────────────────
  drop policy if exists authenticated_all on usage_events;
  drop policy if exists usage_events_read on usage_events;
  execute format('create policy usage_events_read on usage_events for select to authenticated using (%s)', cond_contenido);
  revoke insert, update, delete, truncate, references, trigger on usage_events from authenticated;
end $$;

-- Las vistas de consumo corrían con los permisos del dueño (bypass de RLS): pasan a evaluar la
-- RLS de usage_events con el que consulta.
alter view usage_daily set (security_invoker = true);
alter view usage_hourly_heatmap set (security_invoker = true);
revoke all on usage_daily, usage_hourly_heatmap from anon;
revoke insert, update, delete, truncate, references, trigger on usage_daily, usage_hourly_heatmap from authenticated;

-- ── alerts: leer y reconocer todos; crear/borrar solo servidor (insertAlert) ───
-- «Reconocer» toca solo acknowledged_at/acknowledged_by (privilegio por columna): las columnas
-- del webhook (0076) y el contenido de la alerta no se editan desde una sesión.
drop policy if exists authenticated_all on alerts;
drop policy if exists alerts_read on alerts;
drop policy if exists alerts_acknowledge on alerts;
create policy alerts_read on alerts for select to authenticated using (true);
create policy alerts_acknowledge on alerts for update to authenticated using (true) with check (true);
revoke insert, update, delete, truncate, references, trigger on alerts from authenticated;
grant update (acknowledged_at, acknowledged_by) on alerts to authenticated;

-- ── follow_ups: el panel solo lee (0075) ────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger on follow_ups from authenticated;

-- ── gasto_mes_actual: lee runtime_config → solo service_role ───────────────────
revoke execute on function gasto_mes_actual() from authenticated;
