-- =============================================================
-- 0078_agent_tools_scope.sql
-- Crear o editar http tools (agent_tools: URL y headers) exige alcance `configuracion`
-- TAMBIÉN en la base, no solo en la API.
--
-- Una tool define la URL a la que el servidor manda sus headers con secretos resueltos
-- ({{KOMMO_ACCESS_TOKEN}}, {{TOOL_X}}): quien pueda editarla puede intentar apuntarla a un
-- host propio (el atado de secretos a hosts, lib/http-tool-keys.ts, lo frena, pero la
-- escritura no debe estar abierta). La RLS original (0019) daba `for all` a cualquier
-- `authenticated`, así que un usuario de alcance `operacion` o `contenido` con su JWT podía
-- escribir por PostgREST saltándose el middleware. Ahora:
--   · lectura: cualquier authenticated (el panel muestra las tools);
--   · insert/update/delete: solo quien tenga alcance configuracion en su JWT. Es la MISMA
--     regla que web/src/lib/auth/roles.ts#getScope: sin rol (el maestro del first-run) o
--     `admin`/`configuracion` → sí; `editor`, `contenido`, `operacion` o un valor
--     irreconocible → no (cae cerrado).
-- service_role y el dueño bypassean la RLS (Edge Functions, rutas del servidor).
-- IDEMPOTENTE.
-- =============================================================

-- La condición va INLINE en las policies (no en una función): la RLS evalúa las funciones con los
-- permisos del que consulta, y `authenticated` no ejecuta ninguna función de public salvo las
-- del panel (supabase/tests/function_execute.sql lo impone).
drop function if exists jwt_has_config_scope();

-- anon no tiene nada que hacer acá (la RLS ya lo bloquea; se quita también el privilegio de tabla).
revoke all on agent_tools from anon;

drop policy if exists agent_tools_authenticated on agent_tools;
drop policy if exists agent_tools_read on agent_tools;
drop policy if exists agent_tools_write_config on agent_tools;
drop policy if exists agent_tools_update_config on agent_tools;
drop policy if exists agent_tools_delete_config on agent_tools;

create policy agent_tools_read on agent_tools
  for select to authenticated using (true);
create policy agent_tools_write_config on agent_tools
  for insert to authenticated with check (
    coalesce(
      case
        when nullif(current_setting('request.jwt.claims', true), '') is null then false
        when (nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'role') is null
          or jsonb_typeof(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'role') = 'null' then true
        when nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'role' in ('admin', 'configuracion') then true
        else false
      end,
      false
    )
  );
create policy agent_tools_update_config on agent_tools
  for update to authenticated using (
    coalesce(
      case
        when nullif(current_setting('request.jwt.claims', true), '') is null then false
        when (nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'role') is null
          or jsonb_typeof(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'role') = 'null' then true
        when nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'role' in ('admin', 'configuracion') then true
        else false
      end,
      false
    )
  ) with check (
    coalesce(
      case
        when nullif(current_setting('request.jwt.claims', true), '') is null then false
        when (nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'role') is null
          or jsonb_typeof(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'role') = 'null' then true
        when nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'role' in ('admin', 'configuracion') then true
        else false
      end,
      false
    )
  );
create policy agent_tools_delete_config on agent_tools
  for delete to authenticated using (
    coalesce(
      case
        when nullif(current_setting('request.jwt.claims', true), '') is null then false
        when (nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'role') is null
          or jsonb_typeof(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' -> 'role') = 'null' then true
        when nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'role' in ('admin', 'configuracion') then true
        else false
      end,
      false
    )
  );
