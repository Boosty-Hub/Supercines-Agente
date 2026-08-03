-- =============================================================================
-- 0051 — Contrato agent-side para el Boosty Hub
-- =============================================================================
-- El Boosty Hub monitorea cada agente vía su `agents-collector`, que con el
-- service_role (custodiado en Vault) llama a `hub_metrics()` y lee la tabla
-- `alerts` filtrando por `status=eq.open`. Este contrato faltaba instalarse:
--   1) `hub_metrics()` no existía  → el Hub no veía métricas (404, tolerado).
--   2) `alerts` no tenía `status`  → el Hub recibía 400 y NO espejaba alertas.
--
-- Fuente canónica del RPC: projects-hub `supabase/agent-side/hub_metrics.sql`.
-- Mantener ambos en sync.
-- =============================================================================

-- ── 1) Columna `status` en alerts (contrato que espera el collector) ─────────
-- Derivada de acknowledged_at: 'open' mientras no se reconozca, si no 'resolved'.
-- Generada/stored → siempre consistente, sin poder desincronizarse, y sin
-- cambiar cómo el agente inserta (nunca escribe `status`).
alter table public.alerts
  add column if not exists status text
  generated always as (case when acknowledged_at is null then 'open' else 'resolved' end) stored;

-- Índice parcial para el filtro del collector (status=eq.open).
create index if not exists alerts_open_idx on public.alerts (created_at desc) where acknowledged_at is null;

-- ── 2) hub_metrics() — agregados sin PII/secretos para el Centro de IA ───────
-- SECURITY DEFINER + search_path fijo; solo service_role (REVOKE de PUBLIC/anon).
create or replace function public.hub_metrics()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with
   msg as (select
     count(*) filter (where created_at::date = now()::date)              as in_today,
     count(*) filter (where created_at > now() - interval '7 days')      as in_7d,
     count(*) filter (where created_at >= date_trunc('month', now()))    as in_month,
     max(created_at)                                                     as last_inbound
     from public.messages),
   drf as (select
     count(*) filter (where created_at::date = now()::date and sent_at is not null)          as out_today,
     count(*) filter (where created_at > now() - interval '7 days' and sent_at is not null)   as out_7d,
     count(*) filter (where created_at >= date_trunc('month', now()) and sent_at is not null) as out_month,
     count(*) filter (where created_at > now() - interval '7 days' and sent_at is null)       as shadow_7d,
     count(*) filter (where created_at > now() - interval '7 days')                           as gen_7d,
     count(*) filter (where status = 'failed' and created_at > now() - interval '7 days')     as failed_7d
     from public.drafts),
   usg as (select
     round(coalesce(sum(estimated_cost_usd) filter (where created_at::date = now()::date), 0), 2)           as cost_today,
     round(coalesce(sum(estimated_cost_usd) filter (where created_at >= date_trunc('month', now())), 0), 2) as cost_month,
     round(coalesce(sum(estimated_cost_usd) filter (where created_at > now() - interval '7 days'), 0), 2)   as cost_7d,
     coalesce(sum(input_tokens + output_tokens) filter (where created_at > now() - interval '7 days'), 0)   as tokens_7d,
     max(created_at)                                                                                        as last_event
     from public.usage_events),
   lat as (select
     round(avg(runtime_ms))                                                          as llm_avg_ms,
     round(percentile_cont(0.95) within group (order by runtime_ms))                 as llm_p95_ms
     from public.usage_events
     where component = 'generate_response' and created_at > now() - interval '7 days'),
   clat as (select
     round(percentile_cont(0.5) within group (order by extract(epoch from d.created_at - m.created_at)))  as cust_p50_s,
     round(percentile_cont(0.95) within group (order by extract(epoch from d.created_at - m.created_at))) as cust_p95_s
     from public.drafts d join public.messages m on m.id = d.message_id
     where d.created_at > now() - interval '7 days'
       and d.created_at >= m.created_at
       and d.created_at < m.created_at + interval '1 hour'),
   q as (select
     count(*) filter (where status = 'pending')    as pending,
     count(*) filter (where status = 'processing') as processing
     from public.inbound_queue
     where status in ('pending', 'processing')),
   mdl as (select model from public.usage_events
     where created_at > now() - interval '7 days' and model is not null
     group by model order by count(*) desc limit 1)
  select jsonb_build_object(
    'schema_version', 1,
    'generated_at', now(),
    'model', (select model from mdl),
    'messages', jsonb_build_object(
      'in_today', (select in_today from msg), 'in_7d', (select in_7d from msg), 'in_month', (select in_month from msg),
      'out_today', (select out_today from drf), 'out_7d', (select out_7d from drf), 'out_month', (select out_month from drf),
      'shadow_7d', (select shadow_7d from drf), 'generated_7d', (select gen_7d from drf)),
    'cost', jsonb_build_object(
      'today', (select cost_today from usg), 'month', (select cost_month from usg),
      'd7', (select cost_7d from usg), 'tokens_7d', (select tokens_7d from usg)),
    'latency', jsonb_build_object(
      'llm_avg_ms', (select llm_avg_ms from lat), 'llm_p95_ms', (select llm_p95_ms from lat),
      'customer_p50_s', (select cust_p50_s from clat), 'customer_p95_s', (select cust_p95_s from clat)),
    'queue', jsonb_build_object(
      'pending', (select pending from q), 'processing', (select processing from q)),
    'health', jsonb_build_object(
      'last_event_at', (select last_event from usg), 'last_inbound_at', (select last_inbound from msg),
      'failed_drafts_7d', (select failed_7d from drf))
  );
$$;

revoke all on function public.hub_metrics() from public;
revoke all on function public.hub_metrics() from anon, authenticated;
grant execute on function public.hub_metrics() to service_role;

comment on function public.hub_metrics() is
  'Boosty Hub AI Ops: agregados de métricas (sin PII/secretos). Solo service_role. Ver supabase/agent-side/hub_metrics.sql en projects-hub.';
