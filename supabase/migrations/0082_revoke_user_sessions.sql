-- =============================================================
-- 0082_revoke_user_sessions.sql
-- revoke_user_sessions(p_user_id): corta las sesiones de un usuario (refresh tokens y sesiones
-- de Supabase Auth) y devuelve cuántas filas borró.
--
-- POR QUÉ: el alcance viaja en el JWT (app_metadata.role). Al BAJARLE el alcance a alguien o
-- borrarlo desde /usuarios, su sesión seguía viva: con el refresh token obtenía JWT nuevos
-- indefinidamente (al borrar) o mantenía el alcance viejo hasta refrescar. /api/users la llama
-- (con service_role) después de cambiar el rol o antes de borrar: el refresh token deja de
-- servir y el siguiente login emite un JWT con el alcance nuevo. El access token ya emitido
-- vale hasta su `exp` (JWT expiry del proyecto, 1 h por default): esa ventana es la cota.
--
-- Esquema de Auth: en Supabase `auth.sessions(id, user_id uuid)` y
-- `auth.refresh_tokens(user_id varchar, session_id → sessions on delete cascade)`. Una imagen
-- sin la migración de sesiones de GoTrue no tiene `auth.sessions`: se borra lo que exista.
-- Se borran los refresh tokens por user_id (incluye los viejos sin session_id) y después las
-- sesiones (en cascada se van sus refresh tokens y factores amr).
--
-- SECURITY DEFINER (el panel no tiene privilegios sobre auth) con search_path fijo y el guard
-- `end_user_request()`: una petición con claims de usuario se rechaza aunque alguien le
-- re-otorgue EXECUTE. Solo service_role la ejecuta.
-- IDEMPOTENTE.
-- =============================================================

create or replace function revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tokens   integer := 0;
  v_sessions integer := 0;
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null then
    raise exception 'revoke_user_sessions: p_user_id es obligatorio' using errcode = 'invalid_parameter_value';
  end if;

  if to_regclass('auth.refresh_tokens') is not null then
    delete from auth.refresh_tokens where user_id = p_user_id::text;
    get diagnostics v_tokens = row_count;
  end if;
  if to_regclass('auth.sessions') is not null then
    delete from auth.sessions where user_id = p_user_id;
    get diagnostics v_sessions = row_count;
  end if;
  return v_tokens + v_sessions;
end $$;

revoke execute on function revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function revoke_user_sessions(uuid) to service_role;
