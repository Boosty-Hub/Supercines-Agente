-- =============================================================
-- 0075_agent_tools_scope.sql
-- (1) Todo usuario existente queda con un alcance EXPLÍCITO en app_metadata.role.
-- (2) Leer, crear o editar http tools (agent_tools: URL y headers) exige alcance
--     `configuracion` TAMBIÉN en la base, no solo en la API.
--
-- (1) SIN ROL = SIN ACCESO (fail-closed). Hasta esta versión la ausencia de
-- `app_metadata.role` valía como alcance total (era el maestro que crea el /first-run, anterior
-- al módulo de usuarios). Desde 0078/0079 la RLS (y web/src/lib/auth/roles.ts#getScope) tratan
-- la ausencia como «sin acceso»: solo `configuracion`/`admin`, `contenido`/`editor` y
-- `operacion` abren algo. Para que NADIE legítimo pierda acceso al desplegar en un cliente vivo,
-- ANTES de que cambie cualquier policy (esta es la primera migración que lee el rol) se fija
-- `role = 'configuracion'` a todo usuario existente sin rol: su acceso efectivo de hoy.
-- Un rol presente (incluso irreconocible) no se toca: hoy ya cae cerrado y debe seguir así.
-- El JWT vigente de ese usuario no trae el rol hasta que la sesión se refresca (≤ 1 h, o al
-- volver a entrar). Orden de deploy en CLAUDE.md «Quién entra y hasta dónde».
-- Usuarios creados DESPUÉS: el /first-run y /usuarios siempre fijan el alcance; uno creado a
-- mano sin rol (Admin API, SQL) no ve nada hasta que se le asigne.
--
-- (2) Una tool define la URL a la que el servidor manda sus headers con secretos resueltos
-- ({{KOMMO_ACCESS_TOKEN}}, {{TOOL_X}}): quien pueda editarla puede intentar apuntarla a un
-- host propio (el atado de secretos a hosts, lib/http-tool-keys.ts, lo frena, pero la
-- escritura no debe estar abierta), y quien la lea ve URLs internas y qué secretos usa cada
-- header. La RLS original (0019) daba `for all` a cualquier `authenticated`, así que un usuario
-- de alcance `operacion` o `contenido` con su JWT podía leerlas y escribirlas por PostgREST
-- saltándose el middleware. Ahora lectura y escritura: solo alcance configuracion
-- (`configuracion` o su alias `admin` en el JWT). El panel de tools ya es de ese alcance
-- (/tools, /api/tools, /agent, /api/agent, /api/setup); ninguna vista de otro alcance las lee.
--
-- service_role y el dueño bypassean la RLS (Edge Functions, rutas del servidor).
-- IDEMPOTENTE (se puede aplicar dos veces: la 2.ª vez el maestro ya tiene rol).
-- =============================================================

-- ── (1) Backfill del alcance: SOLO el usuario MAESTRO ───────────────────────────
-- Hasta ahora «sin rol» equivalía a `configuracion`: el maestro del /first-run (el primer usuario
-- del proyecto) nunca tuvo rol. Ahora sin rol = sin acceso. Para que el cliente existente no se
-- quede sin administrador, el maestro —el creado PRIMERO (order by created_at, id)— recibe
-- `configuracion` explícito. NINGÚN otro usuario sin rol se promueve: si el proyecto tuvo el
-- registro público abierto, una cuenta creada por un tercero no debe heredar el acceso total
-- (se queda «Sin acceso» y /usuarios le avisa al operador para que le asigne un rol, o la borre).
-- ANTES de aplicar esta migración, el operador debe asignar rol explícito a los demás usuarios
-- legítimos existentes (ver «Actualizar un cliente ya desplegado» en el README): quien no tenga
-- rol queda sin acceso.
-- jsonb `||` conserva el resto de app_metadata (provider, providers…).
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'configuracion')
 where id = (select u.id from auth.users u order by u.created_at, u.id limit 1)
   and (raw_app_meta_data is null
        or raw_app_meta_data -> 'role' is null
        or jsonb_typeof(raw_app_meta_data -> 'role') = 'null'
        or raw_app_meta_data ->> 'role' = '');

-- ── (2) agent_tools: solo configuracion ──────────────────────────────────────────
-- La condición va INLINE en las policies (no en una función): la RLS evalúa las funciones con los
-- permisos del que consulta, y `authenticated` no ejecuta ninguna función de public salvo las
-- del panel (supabase/tests/function_execute.sql lo impone). Rol ausente, null, no-texto o
-- irreconocible ⇒ `->>` no está en la lista ⇒ false (cae cerrado). Misma expresión que 0079.
drop function if exists jwt_has_config_scope();

-- anon no tiene nada que hacer acá (la RLS ya lo bloquea; se quita también el privilegio de tabla).
revoke all on agent_tools from anon;
revoke truncate, references, trigger on agent_tools from authenticated;

drop policy if exists agent_tools_authenticated on agent_tools;
drop policy if exists agent_tools_read on agent_tools;
drop policy if exists agent_tools_write_config on agent_tools;
drop policy if exists agent_tools_update_config on agent_tools;
drop policy if exists agent_tools_delete_config on agent_tools;
drop policy if exists agent_tools_config on agent_tools;

create policy agent_tools_config on agent_tools
  for all to authenticated
  using (coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'role') in ('admin', 'configuracion'),
    false))
  with check (coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'role') in ('admin', 'configuracion'),
    false));
