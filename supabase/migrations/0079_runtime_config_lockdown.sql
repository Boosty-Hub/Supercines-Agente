-- =============================================================
-- 0076_runtime_config_lockdown.sql
-- La RLS distingue alcances y cae CERRADA: los secretos, la configuración y los datos
-- operativos dejan de estar abiertos a cualquier sesión por PostgREST.
--
-- PROBLEMA: `runtime_config` (0017) tenía `for all to authenticated using (true)`. Ahí viven en
-- texto plano ANTHROPIC_API_KEY, KOMMO_ACCESS_TOKEN, OPENAI_API_KEY, los TOOL_* de las http
-- tools, SHOPIFY_*, BCV_RATE_APIKEY… Un usuario de alcance `operacion` o `contenido` (que no
-- debe ver credenciales) podía, con su propio JWT y la anon key (pública por diseño), leerlas
-- todas y reescribir la config (SYSTEM_PROMPT, KOMMO_API_DOMAIN, TOOL_X_HOSTS, modelos, techo
-- de gasto…) saltándose el middleware del panel. Lo mismo con `alert_config.webhook_url` (un
-- secreto: quien lo tiene postea en el canal del operador), `kommo_credentials` (tokens), las
-- tablas de config que solo edita `configuracion` y los datos operativos: cualquier sesión podía
-- BORRAR leads/mensajes/drafts, reescribir el texto o el estado de un draft (p. ej. marcar
-- `sent` uno no enviado), vaciar `inbound_queue` (lo que hace /api/incidents/skip-queue, que es
-- de alcance configuracion) o reconocer alertas a nombre de otro.
--
-- FIX (mínimo privilegio, matriz completa en CLAUDE.md «Quién entra y hasta dónde»). Para cada
-- tabla gestionada acá: se borran TODAS sus policies, `REVOKE ALL` a anon/authenticated/PUBLIC
-- y se otorga exactamente lo necesario (privilegio de tabla o de COLUMNA + policy por alcance):
--   · Solo servidor (service_role, tras validar sesión + alcance en la ruta): runtime_config,
--     kommo_credentials, alert_config, _migrations, _app_secrets, inbound_queue (payloads
--     crudos; omitir atascados = /api/incidents/skip-queue con service_role) y las tablas
--     internas de coordinación (kommo_backfill_seen, kommo_sync_state, lead_move_claims,
--     lead_position_seen). Sin privilegio y sin policy (RLS habilitada ⇒ negado aunque alguien
--     re-otorgue el GRANT).
--   · Configuracion (lectura y escritura): agent_skip_rules, follow_up_fields/templates/steps
--     (agent_tools lo hace 0078).
--   · Lectura operacion+, escritura configuracion: kommo_publish_config. system_incidents:
--     lectura operacion+; configuracion solo SILENCIA (UPDATE de muted_until/muted_by, y
--     muted_by = quien silencia); insertar/resolver es del health-scan.
--   · Lectura contenido+, escritura configuracion: follow_up_config (la usa /consumo).
--   · Contenido+ (lectura y escritura): graders, promotions, situations, kb_documents,
--     kb_chunks, voice_samples, memory_items. verticals: lectura operacion+ (el inbox muestra la
--     vertical), escritura contenido+. usage_events: lectura contenido+, sin escritura; sus
--     vistas usage_daily / usage_hourly_heatmap pasan a security_invoker (antes corrían como
--     dueño y anon las leía).
--   · Datos operativos, lectura operacion+ y SIN insert/delete para nadie con sesión (los
--     escriben Edge Functions y rutas del servidor con service_role):
--       leads, outcomes, lead_stage_events, follow_ups, kommo_pipelines, kommo_stages,
--       kommo_webhook_auth (estado; el secreto vive en _app_secrets) y kommo_backfill (todas las
--       columnas menos lease_token).
--       messages: UPDATE solo de requires_human_review (marcar/desmarcar revisión humana).
--       drafts: UPDATE solo de status, edited_body, reviewer_id; solo desde pending/approved y
--         solo hacia approved/rejected, con reviewer_id = quien revisa (aprobar, editar el texto,
--         rechazar). `publishing` lo protege además drafts_guard_in_flight (0074).
--       alerts: UPDATE solo de acknowledged_at/acknowledged_by con acknowledged_by = quien
--         reconoce (nadie reconoce a nombre de otro); insert/delete solo servidor (insertAlert).
--   · anon: NINGÚN privilegio sobre tablas, vistas ni secuencias de public (el panel nunca usa
--     el rol anon para datos).
--   · Default privileges: ni anon NI authenticated reciben privilegios en tablas/secuencias
--     FUTURAS de public (Supabase les da ALL por default). Una tabla nueva nace cerrada: su
--     migración otorga lo que necesite y la suma a la matriz (supabase/tests/rls_coverage.sql).
--   · gasto_mes_actual(): lee runtime_config (BUDGET_EXCLUDE_BEFORE) y es SECURITY INVOKER, así
--     que con la sesión ya no puede correr; /consumo la llama con service_role tras validar el
--     alcance → se le quita EXECUTE a authenticated (function_execute.sql lo verifica).
--
-- El alcance sale de `app_metadata.role` del JWT (solo escribible con service_role) con la
-- MISMA regla que web/src/lib/auth/roles.ts#getScope: `configuracion`/`admin` → configuracion;
-- `contenido`/`editor` → contenido; `operacion` → operacion; SIN ROL o un valor irreconocible
-- → SIN ACCESO (fail-closed; 0078 le fijó `configuracion` a los usuarios existentes sin rol).
-- La condición va INLINE en cada policy (como en 0078): la RLS evalúa funciones con los
-- permisos del que consulta y `authenticated` no ejecuta funciones de public salvo las del
-- panel. Se arma una sola vez acá y se reparte con format(). El «quién soy» de los with check
-- lee `request.jwt.claim.sub` o, si no está, `request.jwt.claims ->> 'sub'` (la forma de
-- auth.uid() en Supabase; la de algunas imágenes solo lee el primero).
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
  role_expr text;
  sub_expr text;
  cond_operacion text;
  cond_contenido text;
  cond_config text;
  t text;
  p record;
begin
  role_expr := format('(%s::jsonb -> ''app_metadata'' ->> ''role'')', c);
  -- Rol ausente, null, no-texto o irreconocible ⇒ no está en la lista ⇒ false.
  cond_operacion := format('coalesce(%s in (''admin'', ''configuracion'', ''editor'', ''contenido'', ''operacion''), false)', role_expr);
  cond_contenido := format('coalesce(%s in (''admin'', ''configuracion'', ''editor'', ''contenido''), false)', role_expr);
  cond_config    := format('coalesce(%s in (''admin'', ''configuracion''), false)', role_expr);
  sub_expr := format(
    'coalesce(nullif(current_setting(''request.jwt.claim.sub'', true), ''''), %s::jsonb ->> ''sub'')::uuid', c);

  -- ── Tablas gestionadas: sin policies previas ni privilegios heredados ────────
  foreach t in array array[
    'runtime_config', 'kommo_credentials', 'alert_config', '_migrations', '_app_secrets', 'inbound_queue',
    'kommo_backfill_seen', 'kommo_sync_state', 'lead_move_claims', 'lead_position_seen',
    'agent_skip_rules', 'follow_up_fields', 'follow_up_templates', 'follow_up_steps',
    'kommo_publish_config', 'system_incidents', 'follow_up_config',
    'graders', 'promotions', 'situations', 'kb_documents', 'kb_chunks', 'voice_samples', 'memory_items',
    'verticals', 'usage_events', 'alerts',
    'leads', 'messages', 'drafts', 'outcomes', 'lead_stage_events', 'follow_ups',
    'kommo_pipelines', 'kommo_stages', 'kommo_webhook_auth', 'kommo_backfill'
  ] loop
    if to_regclass('public.' || t) is null then
      -- _migrations la crea el runner del panel; un deploy por CLI no la tiene.
      continue when t = '_migrations';
      raise exception '0079: falta la tabla %, la matriz de alcances quedaría incompleta', t;
    end if;
    for p in select polname from pg_policy where polrelid = ('public.' || t)::regclass loop
      execute format('drop policy %I on %I', p.polname, t);
    end loop;
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated, public', t);
    execute format('grant all on %I to service_role', t);
  end loop;

  -- ── anon: nada sobre tablas/vistas/secuencias de public, tampoco las futuras ──
  -- ── authenticated: nada por default en las futuras (se otorga explícito) ─────
  execute 'revoke all on all tables in schema public from anon';
  execute 'revoke all on all sequences in schema public from anon';
  foreach t in array array[current_user::text, 'postgres', 'supabase_admin'] loop
    if exists (select 1 from pg_roles where rolname = t) then
      begin
        execute format('alter default privileges for role %I in schema public revoke all on tables from anon, authenticated', t);
        execute format('alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated', t);
      exception when insufficient_privilege then
        raise notice 'default privileges de % no modificados (sin permiso): ejecutar como ese rol', t;
      end;
    end if;
  end loop;

  -- ── Solo configuracion (lectura y escritura) ─────────────────────────────────
  foreach t in array array['agent_skip_rules', 'follow_up_fields', 'follow_up_templates', 'follow_up_steps'] loop
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('create policy %I on %I for all to authenticated using (%s) with check (%s)', t || '_config', t, cond_config, cond_config);
  end loop;

  -- ── kommo_publish_config: lectura operacion+, escritura configuracion ────────
  grant select, insert, update, delete on kommo_publish_config to authenticated;
  execute format('create policy kommo_publish_config_read on kommo_publish_config for select to authenticated using (%s)', cond_operacion);
  execute format('create policy kommo_publish_config_insert_config on kommo_publish_config for insert to authenticated with check (%s)', cond_config);
  execute format('create policy kommo_publish_config_update_config on kommo_publish_config for update to authenticated using (%s) with check (%s)', cond_config, cond_config);
  execute format('create policy kommo_publish_config_delete_config on kommo_publish_config for delete to authenticated using (%s)', cond_config);

  -- ── system_incidents: lectura operacion+; configuracion solo silencia ────────
  grant select on system_incidents to authenticated;
  grant update (muted_until, muted_by) on system_incidents to authenticated;
  execute format('create policy system_incidents_read on system_incidents for select to authenticated using (%s)', cond_operacion);
  execute format('create policy system_incidents_mute_config on system_incidents for update to authenticated using (%s) with check (%s and muted_by = %s)',
    cond_config, cond_config, sub_expr);

  -- ── follow_up_config: lectura contenido+, escritura configuracion ────────────
  grant select, insert, update, delete on follow_up_config to authenticated;
  execute format('create policy follow_up_config_read on follow_up_config for select to authenticated using (%s)', cond_contenido);
  execute format('create policy follow_up_config_insert_config on follow_up_config for insert to authenticated with check (%s)', cond_config);
  execute format('create policy follow_up_config_update_config on follow_up_config for update to authenticated using (%s) with check (%s)', cond_config, cond_config);
  execute format('create policy follow_up_config_delete_config on follow_up_config for delete to authenticated using (%s)', cond_config);

  -- ── Contenido+ (lectura y escritura) ─────────────────────────────────────────
  foreach t in array array['graders', 'promotions', 'situations', 'kb_documents', 'kb_chunks', 'voice_samples', 'memory_items'] loop
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('create policy %I on %I for all to authenticated using (%s) with check (%s)', t || '_contenido', t, cond_contenido, cond_contenido);
  end loop;

  -- ── verticals: lectura operacion+, escritura contenido+ ──────────────────────
  grant select, insert, update, delete on verticals to authenticated;
  execute format('create policy verticals_read on verticals for select to authenticated using (%s)', cond_operacion);
  execute format('create policy verticals_insert_contenido on verticals for insert to authenticated with check (%s)', cond_contenido);
  execute format('create policy verticals_update_contenido on verticals for update to authenticated using (%s) with check (%s)', cond_contenido, cond_contenido);
  execute format('create policy verticals_delete_contenido on verticals for delete to authenticated using (%s)', cond_contenido);

  -- ── usage_events: lectura contenido+, escritura solo servidor ────────────────
  grant select on usage_events to authenticated;
  execute format('create policy usage_events_read on usage_events for select to authenticated using (%s)', cond_contenido);

  -- ── alerts: lectura operacion+; reconocer a nombre propio ────────────────────
  grant select on alerts to authenticated;
  grant update (acknowledged_at, acknowledged_by) on alerts to authenticated;
  execute format('create policy alerts_read on alerts for select to authenticated using (%s)', cond_operacion);
  execute format('create policy alerts_acknowledge on alerts for update to authenticated using (%s) with check (%s and acknowledged_by = %s)',
    cond_operacion, cond_operacion, sub_expr);

  -- ── Datos operativos: lectura operacion+, sin escritura con la sesión ─────────
  foreach t in array array['leads', 'messages', 'drafts', 'outcomes', 'lead_stage_events', 'follow_ups',
                           'kommo_pipelines', 'kommo_stages', 'kommo_webhook_auth'] loop
    execute format('grant select on %I to authenticated', t);
    execute format('create policy %I on %I for select to authenticated using (%s)', t || '_read', t, cond_operacion);
  end loop;
  -- kommo_backfill: el estado del recorrido sí, el token del lease no.
  grant select (job, status, next_page, scanned, updated, last_error, started_at, finished_at, updated_at, lease_until)
    on kommo_backfill to authenticated;
  execute format('create policy kommo_backfill_read on kommo_backfill for select to authenticated using (%s)', cond_operacion);

  -- messages: el inbox solo marca/desmarca la revisión humana.
  grant update (requires_human_review) on messages to authenticated;
  execute format('create policy messages_review on messages for update to authenticated using (%s) with check (%s)',
    cond_operacion, cond_operacion);

  -- drafts: aprobar (con o sin edición) o rechazar lo que todavía no se reservó para enviar.
  grant update (status, edited_body, reviewer_id) on drafts to authenticated;
  execute format(
    'create policy drafts_review on drafts for update to authenticated '
    'using (%s and status in (''pending'', ''approved'')) '
    'with check (%s and status in (''approved'', ''rejected'') and reviewer_id = %s)',
    cond_operacion, cond_operacion, sub_expr);
end $$;

-- Las vistas de consumo corrían con los permisos del dueño (bypass de RLS): pasan a evaluar la
-- RLS de usage_events con el que consulta.
alter view usage_daily set (security_invoker = true);
alter view usage_hourly_heatmap set (security_invoker = true);
revoke all on usage_daily, usage_hourly_heatmap from anon, public;
revoke insert, update, delete, truncate, references, trigger on usage_daily, usage_hourly_heatmap from authenticated;
grant select on usage_daily, usage_hourly_heatmap to authenticated;

-- ── gasto_mes_actual: lee runtime_config → solo service_role ───────────────────
revoke execute on function gasto_mes_actual() from authenticated;
