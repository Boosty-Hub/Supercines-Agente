-- =============================================================
-- 0060_budget_gate.sql
-- Techo de gasto mensual (runtime_config.MONTHLY_BUDGET_USD).
--
-- Segunda red de seguridad, independiente de los frenos por lead
-- (response_cooldown_seconds / max_responses_per_lead): cubre un gasto AGREGADO
-- disparado por otra vía (ráfaga de leads distintos, cambio de precio o de
-- modelo, un bug propio). Ver supabase/functions/_shared/budget.ts.
--
-- Esta migración agrega solo:
--   1) gasto_mes_actual(): lo gastado en el mes en curso (UTC), leído de
--      usage_events.estimated_cost_usd (0034), que ya valúa cada llamada y ya
--      tiene índice por created_at — no hace falta ninguno nuevo.
--   2) 'budget_exceeded' entre los kinds de alerta que empujan al webhook
--      (Slack/Discord), igual que 0054.
--   3) las dos keys de config, sembradas en NULL (= sin freno).
--
-- MONTHLY_BUDGET_USD y BUDGET_EXCLUDE_BEFORE no son columnas: son
-- runtime_config comunes (DB-first/env-fallback, 0017), editables desde
-- /consumo. Ausentes o "0" = SIN freno: nunca cambia el comportamiento por
-- defecto de un despliegue existente.
--
-- BUDGET_EXCLUDE_BEFORE (ISO 8601, opcional): no cuenta el gasto anterior a esa
-- fecha. Sirve para activar el techo a mitad de mes sin que lo ya gastado lo
-- dispare de entrada. /consumo la escribe al activar el techo.
--
-- SEGURIDAD: la función es SECURITY INVOKER (default) y devuelve un agregado
-- de costo; igual se le saca EXECUTE a PUBLIC/anon (Postgres lo da a PUBLIC por
-- default) y solo la usan service_role (Edge) y authenticated (panel /consumo).
--
-- IDEMPOTENTE.
-- =============================================================

create or replace function gasto_mes_actual()
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_desde timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_excl  timestamptz;
begin
  -- BUDGET_EXCLUDE_BEFORE inválido (edición manual de runtime_config) se IGNORA
  -- con un warning: antes el cast fallaba, la función tiraba y el gate quedaba
  -- fail-open EN SILENCIO (freno apagado sin que nadie se entere).
  begin
    select nullif(value, '')::timestamptz into v_excl
      from runtime_config where key = 'BUDGET_EXCLUDE_BEFORE';
  exception when others then
    raise warning 'gasto_mes_actual: BUDGET_EXCLUDE_BEFORE inválido, se ignora';
    v_excl := null;
  end;
  if v_excl is not null and v_excl > v_desde then
    v_desde := v_excl;
  end if;

  return (select coalesce(sum(estimated_cost_usd), 0)::numeric
            from usage_events
           where created_at >= v_desde);
end;
$$;

comment on function gasto_mes_actual() is
  'Suma estimated_cost_usd de usage_events desde el inicio del mes en curso (UTC), o desde runtime_config.BUDGET_EXCLUDE_BEFORE si es más reciente. Usada por _shared/budget.ts para el techo de gasto mensual (runtime_config.MONTHLY_BUDGET_USD).';

revoke execute on function gasto_mes_actual() from public, anon;
grant execute on function gasto_mes_actual() to authenticated, service_role;

insert into runtime_config (key, value, is_secret) values
  ('MONTHLY_BUDGET_USD',    null, false),
  ('BUDGET_EXCLUDE_BEFORE', null, false)
on conflict (key) do nothing;

alter table alert_config
  alter column webhook_kinds
  set default array[
    'draft_failed',
    'human_review_needed',
    'outcomes_regression',
    'inbound_silence',
    'budget_exceeded'
  ]::text[];

update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'budget_exceeded')
 where not ('budget_exceeded' = any(webhook_kinds));
