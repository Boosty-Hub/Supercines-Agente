-- =============================================================
-- 0072_revoke_anon_tables.sql
-- `anon` (la clave pública del bundle) no necesita NINGÚN privilegio sobre las
-- tablas de public: el panel entra con la sesión del usuario (rol authenticated),
-- las Edge Functions con service_role y no hay ninguna página pública que lea la
-- base. Supabase, sin embargo, otorga por default ALL sobre toda tabla nueva a
-- anon/authenticated/service_role; la RLS evita que anon vea filas (medido en
-- producción: 200 con []), pero el privilegio no tiene por qué existir (estándar de
-- seguridad de Boosty: least privilege, RLS como segunda barrera y no como única).
--
-- 1) REVOKE ALL a anon sobre todas las tablas, vistas y secuencias de public.
-- 2) Los default privileges ya no se las dan a las tablas FUTURAS.
-- authenticated y service_role no se tocan. IDEMPOTENTE.
-- =============================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon;
    revoke all on all sequences in schema public from anon;
  end if;
end $$;

do $$
declare
  r text;
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    return;
  end if;
  foreach r in array array[current_user::text, 'postgres', 'supabase_admin'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      begin
        execute format('alter default privileges for role %I in schema public revoke all on tables from anon', r);
        execute format('alter default privileges for role %I in schema public revoke all on sequences from anon', r);
      exception when insufficient_privilege then
        raise notice 'default privileges de % no modificados (sin permiso): ejecutar como ese rol', r;
      end;
    end if;
  end loop;
end $$;
