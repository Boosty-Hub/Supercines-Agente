-- Cobertura de la RLS y de los privilegios por default (S3), contra un Postgres con TODAS las
-- migraciones aplicadas:
--   1) TODA tabla de public tiene RLS habilitada (excepciones: lista cerrada con su motivo; hoy
--      ninguna).
--   2) Toda vista de public es security_invoker (si no, corre como su dueño y bypasea la RLS).
--   3) Ninguna tabla de public queda SIN CLASIFICAR: cada una está en la matriz de abajo con los
--      privilegios de tabla EXACTOS de `authenticated` (la matriz de CLAUDE.md «Quién entra y
--      hasta dónde»). Una tabla nueva rompe este test hasta que se decida su alcance.
--   4) Los default privileges NO dan nada a anon ni a authenticated en tablas, secuencias ni
--      funciones futuras de public (Supabase les da ALL por default), y una tabla/secuencia/vista
--      creada ahora nace sin privilegios para ellos.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/rls_coverage.sql   (ver supabase/tests/README.md)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

create temp view tablas as
  select c.oid, c.relname::text as rel, c.relkind, c.relrowsecurity, c.reloptions
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
     and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e');

-- ── 1) RLS habilitada en TODA tabla ──────────────────────────────────────────────
-- Excepciones (tabla → motivo). Agregar una exige justificarla acá y en CLAUDE.md. Hoy: ninguna.
create temp table sin_rls_permitidas (rel text primary key, motivo text not null);

select pg_temp.expect('toda tabla de public tiene RLS habilitada; sin RLS: ' ||
    coalesce((select string_agg(rel, ', ') from tablas
               where relkind in ('r', 'p') and not relrowsecurity
                 and rel not in (select rel from sin_rls_permitidas)), '-'),
  not exists (select 1 from tablas
               where relkind in ('r', 'p') and not relrowsecurity
                 and rel not in (select rel from sin_rls_permitidas)));

-- ── 2) Vistas security_invoker ───────────────────────────────────────────────────
select pg_temp.expect('toda vista de public es security_invoker; no lo son: ' ||
    coalesce((select string_agg(rel, ', ') from tablas
               where relkind = 'v' and not coalesce('security_invoker=true' = any (reloptions), false)), '-'),
  not exists (select 1 from tablas
               where relkind = 'v' and not coalesce('security_invoker=true' = any (reloptions), false)));
select pg_temp.expect('ninguna vista materializada legible por anon/authenticated (no tienen RLS)',
  not exists (select 1 from tablas where relkind = 'm'
                 and (has_table_privilege('anon', oid, 'select') or has_table_privilege('authenticated', oid, 'select'))));

-- ── 3) Matriz: privilegios de TABLA exactos de authenticated ─────────────────────
-- '' = ninguno (solo servidor). Las escrituras finas van por COLUMNA (no figuran acá):
-- drafts (status, edited_body, reviewer_id), messages (requires_human_review), alerts
-- (acknowledged_at/by), system_incidents (muted_until/by), kommo_backfill (select sin lease_token).
create temp table matriz (rel text primary key, privs text not null);
insert into matriz values
  -- solo servidor
  ('runtime_config', ''), ('kommo_credentials', ''), ('alert_config', ''), ('_migrations', ''),
  ('_app_secrets', ''), ('inbound_queue', ''), ('kommo_backfill_seen', ''), ('kommo_sync_state', ''),
  ('lead_move_claims', ''), ('lead_position_seen', ''), ('kommo_backfill', ''), ('dreams_run_lease', ''),
  -- configuracion
  ('agent_tools', 'DELETE,INSERT,SELECT,UPDATE'), ('agent_skip_rules', 'DELETE,INSERT,SELECT,UPDATE'),
  ('follow_up_fields', 'DELETE,INSERT,SELECT,UPDATE'), ('follow_up_templates', 'DELETE,INSERT,SELECT,UPDATE'),
  ('follow_up_steps', 'DELETE,INSERT,SELECT,UPDATE'), ('kommo_publish_config', 'DELETE,INSERT,SELECT,UPDATE'),
  ('follow_up_config', 'DELETE,INSERT,SELECT,UPDATE'),
  -- propias de SuperCines (0080): el equipo del ruteo es de configuracion
  ('routing_assignees', 'DELETE,INSERT,SELECT,UPDATE'), ('routing_state', ''),
  -- contenido
  ('graders', 'DELETE,INSERT,SELECT,UPDATE'), ('promotions', 'DELETE,INSERT,SELECT,UPDATE'),
  ('situations', 'DELETE,INSERT,SELECT,UPDATE'), ('kb_documents', 'DELETE,INSERT,SELECT,UPDATE'),
  ('kb_chunks', 'DELETE,INSERT,SELECT,UPDATE'), ('voice_samples', 'DELETE,INSERT,SELECT,UPDATE'),
  ('memory_items', 'DELETE,INSERT,SELECT,UPDATE'), ('verticals', 'DELETE,INSERT,SELECT,UPDATE'),
  ('usage_events', 'SELECT'), ('usage_daily', 'SELECT'), ('usage_hourly_heatmap', 'SELECT'),
  -- operacion (lectura; escrituras por columna)
  ('alerts', 'SELECT'), ('system_incidents', 'SELECT'), ('leads', 'SELECT'), ('messages', 'SELECT'),
  ('drafts', 'SELECT'), ('outcomes', 'SELECT'), ('lead_stage_events', 'SELECT'), ('follow_ups', 'SELECT'),
  ('kommo_pipelines', 'SELECT'), ('kommo_stages', 'SELECT'), ('kommo_webhook_auth', 'SELECT'),
  -- propias de SuperCines (0080): auditoría del ruteo (operacion+) y embudos de salesbots (contenido+)
  ('lead_routing_events', 'SELECT'), ('salesbot_funnel_leads', 'SELECT'),
  ('lead_inbox_summary', 'SELECT');

create temp view privs_reales as
  select t.rel,
         coalesce((select string_agg(p, ',' order by p)
                     from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
                    where has_table_privilege('authenticated', t.oid, p)
                      -- has_table_privilege con UPDATE/SELECT da true también si hay privilegio de
                      -- COLUMNA en alguna: se cuenta solo el de tabla (aclexplode del relacl).
                      and exists (select 1 from pg_class c, aclexplode(c.relacl) a
                                   where c.oid = t.oid and a.grantee = (select oid from pg_roles where rolname = 'authenticated')
                                     and a.privilege_type = p)), '') as privs
    from tablas t;

select pg_temp.expect('toda tabla/vista de public está clasificada en la matriz; sin clasificar: ' ||
    coalesce((select string_agg(rel, ', ') from tablas where rel not in (select rel from matriz)), '-'),
  not exists (select 1 from tablas where rel not in (select rel from matriz)));
select pg_temp.expect('la matriz no nombra tablas inexistentes: ' ||
    coalesce((select string_agg(rel, ', ') from matriz where rel not in (select rel from tablas)), '-'),
  not exists (select 1 from matriz where rel not in (select rel from tablas)));
select pg_temp.expect('privilegios de tabla de authenticated = matriz; difieren: ' ||
    coalesce((select string_agg(m.rel || ' (real «' || r.privs || '», matriz «' || m.privs || '»)', '; ')
                from matriz m join privs_reales r using (rel) where r.privs <> m.privs), '-'),
  not exists (select 1 from matriz m join privs_reales r using (rel) where r.privs <> m.privs));
select pg_temp.expect('anon sin ningún privilegio de tabla ni de columna en public',
  not exists (select 1 from tablas t
               where has_table_privilege('anon', t.oid, 'select') or has_table_privilege('anon', t.oid, 'insert')
                  or has_table_privilege('anon', t.oid, 'update') or has_table_privilege('anon', t.oid, 'delete')
                  or has_any_column_privilege('anon', t.oid, 'select') or has_any_column_privilege('anon', t.oid, 'update')));
select pg_temp.expect('toda policy de public aplica a authenticated (ninguna a PUBLIC/anon)',
  not exists (select 1 from pg_policy p join tablas t on t.oid = p.polrelid
               where p.polroles <> array['authenticated'::regrole::oid]));

-- ── 4) Default privileges ────────────────────────────────────────────────────────
-- Del rol que corre las migraciones en producción (`postgres`, el del Management API): son los
-- default privileges que aplican a lo que crea cada migración. (supabase_admin es otro rol, no
-- el creador de objetos de un cliente; sus defaults no los puede cambiar `postgres`.)
select pg_temp.expect('pg_default_acl de postgres no otorga nada a anon ni a authenticated en public ni global',
  not exists (
    select 1 from pg_default_acl d, aclexplode(d.defaclacl) a
     where d.defaclrole = 'postgres'::regrole
       and (d.defaclnamespace = 'public'::regnamespace or d.defaclnamespace = 0)
       and a.grantee in ('anon'::regrole, 'authenticated'::regrole)));

-- Se crean como `postgres` (el rol de las migraciones en producción).
set local role postgres;
create table public.zz_tabla_nueva (id bigint generated always as identity primary key, x text);
create view public.zz_vista_nueva as select 1 as x;
create table public.zz_tabla_nueva_pg (id serial primary key);
reset role;
select pg_temp.expect('tabla, secuencia y vista NUEVAS (creadas como postgres) nacen sin privilegios para anon ni authenticated',
  not exists (
    select 1 from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relname in ('zz_tabla_nueva', 'zz_vista_nueva', 'zz_tabla_nueva_pg', 'zz_tabla_nueva_id_seq', 'zz_tabla_nueva_pg_id_seq')
       and exists (select 1 from aclexplode(c.relacl) a where a.grantee in ('anon'::regrole, 'authenticated'::regrole))));
select pg_temp.expect('… y la tabla nueva con RLS deshabilitada la detecta el chequeo 1',
  exists (select 1 from tablas where rel = 'zz_tabla_nueva' and not relrowsecurity));

rollback;
