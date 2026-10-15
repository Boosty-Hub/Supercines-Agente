-- =============================================================
-- 0080_supercines_table_scopes.sql
-- Propia de SuperCines (el template no tiene estas tablas): completa el mínimo privilegio de
-- 0079_runtime_config_lockdown.sql sobre las tablas que solo existen acá. MISMA regla de
-- alcance que 0079 y que web/src/lib/auth/roles.ts#getScope (app_metadata.role del JWT, INLINE
-- en cada policy), y por lo tanto FAIL-CLOSED: sin rol, rol null, no-texto o irreconocible ⇒ no
-- está en la lista ⇒ SIN ACCESO (ni lectura). Matriz en CLAUDE.md «Quién entra y hasta dónde».
--
--   · routing_assignees  — el equipo del ruteo: lectura y escritura solo `configuracion`
--                          (Ajustes → Agente → Acciones; las rutas /api/routing exigen ese alcance).
--   · routing_state      — puntero interno del round robin: solo servidor (Edge Functions).
--   · lead_routing_events— auditoría del ruteo: lectura operacion+, escritura solo servidor
--                          (sin insert/update/delete para nadie con sesión).
--   · salesbot_funnel_leads — lo escribe kommo-funnel-sync (service_role); el panel solo lo lee
--                          (/salesbots, alcance `contenido`): lectura contenido+, sin escritura.
--
-- (lead_stage_events, la otra tabla que comparte SuperCines con el template, ya la deja en
-- lectura operacion+ y sin escritura la 0079: acá NO se vuelve a tocar, para no reabrirla.)
-- service_role y el dueño bypassean la RLS. IDEMPOTENTE.
-- =============================================================

do $$
declare
  c constant text := $c$nullif(current_setting('request.jwt.claims', true), '')$c$;
  role_expr text;
  cond_operacion text;
  cond_contenido text;
  cond_config text;
  t text;
  p record;
begin
  role_expr := format('(%s::jsonb -> ''app_metadata'' ->> ''role'')', c);
  -- Rol ausente, null, no-texto o irreconocible ⇒ no está en la lista ⇒ false (igual que 0079).
  cond_operacion := format('coalesce(%s in (''admin'', ''configuracion'', ''editor'', ''contenido'', ''operacion''), false)', role_expr);
  cond_contenido := format('coalesce(%s in (''admin'', ''configuracion'', ''editor'', ''contenido''), false)', role_expr);
  cond_config    := format('coalesce(%s in (''admin'', ''configuracion''), false)', role_expr);

  -- Estas tablas las crearon migraciones anteriores: si falta alguna, el esquema está incompleto.
  foreach t in array array['routing_assignees', 'routing_state', 'lead_routing_events', 'salesbot_funnel_leads'] loop
    if to_regclass('public.' || t) is null then
      raise exception '0080: falta la tabla %, la matriz de alcances quedaría incompleta', t;
    end if;
    for p in select polname from pg_policy where polrelid = ('public.' || t)::regclass loop
      execute format('drop policy %I on %I', p.polname, t);
    end loop;
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated, public', t);
    execute format('grant all on %I to service_role', t);
  end loop;

  -- routing_assignees: solo configuracion (lectura y escritura). Sin truncate/references/trigger.
  execute 'grant select, insert, update, delete on routing_assignees to authenticated';
  execute format('create policy routing_assignees_config on routing_assignees for all to authenticated using (%s) with check (%s)', cond_config, cond_config);

  -- routing_state: solo servidor (sin privilegio y sin policy: negado aunque alguien re-otorgue).

  -- lead_routing_events: leer operacion+; escribir solo servidor.
  execute 'grant select on lead_routing_events to authenticated';
  execute format('create policy lead_routing_events_read on lead_routing_events for select to authenticated using (%s)', cond_operacion);

  -- salesbot_funnel_leads: leer contenido+; escribir solo servidor.
  execute 'grant select on salesbot_funnel_leads to authenticated';
  execute format('create policy salesbot_funnel_leads_read on salesbot_funnel_leads for select to authenticated using (%s)', cond_contenido);
end $$;
