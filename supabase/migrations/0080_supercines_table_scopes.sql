-- =============================================================
-- 0080_supercines_table_scopes.sql
-- Propia de SuperCines (el template no tiene estas tablas): completa el mínimo privilegio de
-- 0079_runtime_config_lockdown.sql sobre las tablas que solo existen acá. Misma regla de
-- alcance (app_metadata.role del JWT, INLINE en cada policy; ver 0079) y misma matriz
-- (CLAUDE.md «Quién entra y hasta dónde»).
--
--   · routing_assignees  — el equipo del ruteo: lectura y escritura solo `configuracion`
--                          (Ajustes → Agente → Acciones; las rutas /api/routing exigen ese alcance).
--   · routing_state      — puntero interno del round robin: solo servidor (Edge Functions).
--   · lead_routing_events— auditoría del ruteo: lectura para todos, escritura solo servidor.
--   · salesbot_funnel_leads — lo escribe kommo-funnel-sync (service_role); el panel solo lo lee
--                          (/salesbots, alcance `contenido`): lectura contenido+, sin escritura.
--   · lead_stage_events  — historial de etapas: lo escriben record_lead_stage_event /
--                          apply_lead_position (service_role); el panel solo lo lee.
-- service_role y el dueño bypassean la RLS. IDEMPOTENTE.
-- =============================================================

do $$
declare
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

  -- routing_assignees: solo configuracion (lectura y escritura).
  drop policy if exists authenticated_all on routing_assignees;
  drop policy if exists routing_assignees_config on routing_assignees;
  execute format('create policy routing_assignees_config on routing_assignees for all to authenticated using (%s) with check (%s)', cond_config, cond_config);
  revoke truncate, references, trigger on routing_assignees from authenticated;

  -- routing_state: solo servidor.
  drop policy if exists authenticated_all on routing_state;
  revoke all on routing_state from anon, authenticated, public;
  grant all on routing_state to service_role;

  -- lead_routing_events: leer todos; escribir solo servidor.
  drop policy if exists authenticated_all on lead_routing_events;
  drop policy if exists lead_routing_events_read on lead_routing_events;
  create policy lead_routing_events_read on lead_routing_events for select to authenticated using (true);
  revoke insert, update, delete, truncate, references, trigger on lead_routing_events from authenticated;

  -- salesbot_funnel_leads: leer contenido+; escribir solo servidor.
  drop policy if exists authenticated_all on salesbot_funnel_leads;
  drop policy if exists salesbot_funnel_leads_read on salesbot_funnel_leads;
  execute format('create policy salesbot_funnel_leads_read on salesbot_funnel_leads for select to authenticated using (%s)', cond_contenido);
  revoke insert, update, delete, truncate, references, trigger on salesbot_funnel_leads from authenticated;

  -- lead_stage_events: leer todos; escribir solo servidor.
  for t in select policyname from pg_policies where schemaname = 'public' and tablename = 'lead_stage_events' loop
    execute format('drop policy if exists %I on lead_stage_events', t);
  end loop;
  create policy lead_stage_events_read on lead_stage_events for select to authenticated using (true);
  revoke insert, update, delete, truncate, references, trigger on lead_stage_events from authenticated;
end $$;
