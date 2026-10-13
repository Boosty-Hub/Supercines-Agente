-- =============================================================
-- 0069_internal_function_gate.sql
-- Gate interno en TODAS las Edge Functions que no son un webhook público.
--
-- PROBLEMA: las funciones tienen verify_jwt = false (invariante 1: Kommo postea sin
-- JWT) y, salvo sync-pipelines, ningún control más: cualquiera con la URL podía
-- disparar análisis (dreams-run), generar respuestas (generate-response), publicar a
-- clientes (publish-to-kommo), gastar tokens (evaluate-outcomes, embed) o vaciar la
-- cola. Solo kommo-webhook tiene que ser público (Kommo no firma).
--
-- FIX (estándar de seguridad de Boosty): cada función exige el header
-- x-internal-secret (supabase/functions/_shared/auth.ts), el secreto de bajo
-- privilegio INTERNAL_FUNCTION_SECRET de la tabla protegida _app_secrets (0061).
-- Este archivo hace que todos los INVOCADORES SQL lo manden: las funciones trigger_*
-- que ejecuta pg_cron (vía pg_net) se redefinen como SECURITY DEFINER y toman los
-- headers de internal_function_headers() (0061). Los jobs de cron NO cambian: siguen
-- llamando a trigger_* por nombre, y ahora esas funciones mandan el secreto.
--
-- ORDEN DE DESPLIEGUE sin downtime (lo respeta el centro de actualizaciones):
--   1) migraciones — los trigger_* empiezan a mandar el secreto; las funciones
--      VIEJAS (sin gate) ignoran el header, nada se corta;
--   2) funciones, en el orden de embed-provision.mjs (invocadores antes que
--      invocados): los que llaman ya mandan el secreto cuando el invocado empieza
--      a exigirlo;
--   3) web — manda el secreto si existe y, si todavía no (web desplegado antes que
--      la migración), llama sin él y la función vieja responde igual.
-- Una llamada que caiga justo entre dos despliegues recibe 401 y la repone el
-- barrido de pg_cron del minuto siguiente (todos los caminos tienen barrido).
--
-- search_path = public, pg_temp en todas (estándar: una función SECURITY DEFINER no
-- puede resolver objetos en un esquema controlable por el invocador) y sin EXECUTE
-- para PUBLIC/anon/authenticated: Postgres lo da a PUBLIC por default.
--
-- IDEMPOTENTE (create or replace).
-- =============================================================

create or replace function trigger_process_inbound()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Guard (estándar de seguridad de Boosty): SECURITY DEFINER bypasea la RLS. Solo
  -- service_role, pg_cron y el dueño (sin claims de usuario en la petición) pueden ejecutarla; un
  -- usuario con JWT (anon/authenticated) no, aunque algún día alguien le re-otorgue
  -- EXECUTE por error.
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/process-inbound',
    headers := internal_function_headers(),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

create or replace function trigger_publish_to_kommo()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Guard (estándar de seguridad de Boosty): SECURITY DEFINER bypasea la RLS. Solo
  -- service_role, pg_cron y el dueño (sin claims de usuario en la petición) pueden ejecutarla; un
  -- usuario con JWT (anon/authenticated) no, aunque algún día alguien le re-otorgue
  -- EXECUTE por error.
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/publish-to-kommo',
    headers := internal_function_headers(),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

create or replace function trigger_evaluate_outcomes()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Guard (estándar de seguridad de Boosty): SECURITY DEFINER bypasea la RLS. Solo
  -- service_role, pg_cron y el dueño (sin claims de usuario en la petición) pueden ejecutarla; un
  -- usuario con JWT (anon/authenticated) no, aunque algún día alguien le re-otorgue
  -- EXECUTE por error.
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/evaluate-outcomes',
    headers := internal_function_headers(),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

create or replace function trigger_dreams(p_period text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Guard (estándar de seguridad de Boosty): SECURITY DEFINER bypasea la RLS. Solo
  -- service_role, pg_cron y el dueño (sin claims de usuario en la petición) pueden ejecutarla; un
  -- usuario con JWT (anon/authenticated) no, aunque algún día alguien le re-otorgue
  -- EXECUTE por error.
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/dreams-run',
    headers := internal_function_headers(),
    body := jsonb_build_object('period', p_period),
    timeout_milliseconds := 120000
  );
end;
$$;

create or replace function trigger_alerts_scan()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Guard (estándar de seguridad de Boosty): SECURITY DEFINER bypasea la RLS. Solo
  -- service_role, pg_cron y el dueño (sin claims de usuario en la petición) pueden ejecutarla; un
  -- usuario con JWT (anon/authenticated) no, aunque algún día alguien le re-otorgue
  -- EXECUTE por error.
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/alerts-scan',
    headers := internal_function_headers(),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

create or replace function trigger_generate_response()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Guard (estándar de seguridad de Boosty): SECURITY DEFINER bypasea la RLS. Solo
  -- service_role, pg_cron y el dueño (sin claims de usuario en la petición) pueden ejecutarla; un
  -- usuario con JWT (anon/authenticated) no, aunque algún día alguien le re-otorgue
  -- EXECUTE por error.
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/generate-response',
    headers := internal_function_headers(),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$$;

create or replace function trigger_follow_up_scan()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Guard (estándar de seguridad de Boosty): SECURITY DEFINER bypasea la RLS. Solo
  -- service_role, pg_cron y el dueño (sin claims de usuario en la petición) pueden ejecutarla; un
  -- usuario con JWT (anon/authenticated) no, aunque algún día alguien le re-otorgue
  -- EXECUTE por error.
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  perform net.http_post(
    url                  := '${SUPABASE_URL}/functions/v1/follow-up-scan',
    headers              := internal_function_headers(),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

-- Nadie más que el cron (que corre como el dueño de la función) las ejecuta.
revoke execute on function trigger_process_inbound() from public, anon, authenticated;
revoke execute on function trigger_publish_to_kommo() from public, anon, authenticated;
revoke execute on function trigger_evaluate_outcomes() from public, anon, authenticated;
revoke execute on function trigger_dreams(text) from public, anon, authenticated;
revoke execute on function trigger_alerts_scan() from public, anon, authenticated;
revoke execute on function trigger_generate_response() from public, anon, authenticated;
revoke execute on function trigger_follow_up_scan() from public, anon, authenticated;
