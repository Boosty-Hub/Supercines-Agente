-- =============================================================
-- 0034_usage_events.sql
-- Captura de consumo Anthropic (tokens/runtime/costo estimado) por call-site.
-- IDEMPOTENT. RLS mirrors verticals (authenticated all, service_role bypass).
-- =============================================================
create table if not exists usage_events (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  component             text not null,        -- 'classify'|'generate_response'|'dreams'|'grader'|'dashboard_<slug>'
  model                 text not null,
  input_tokens          int,
  output_tokens         int,
  cache_creation_tokens int,
  cache_read_tokens     int,
  is_estimated          boolean not null default false,
  runtime_ms            int,                  -- CMA: round(active_seconds*1000); resto null
  estimated_cost_usd    numeric(12,6),
  lead_id               uuid references leads(id)   on delete set null,
  draft_id              uuid references drafts(id)  on delete set null,
  session_id            text,                 -- CMA: para idempotencia de backfill
  metadata              jsonb                 -- vertical, grader_id, batch_size, tool_calls, source='backfill', etc.
);

create index if not exists usage_events_created_idx      on usage_events(created_at);
create index if not exists usage_events_comp_created_idx  on usage_events(component, created_at);
create index if not exists usage_events_model_created_idx on usage_events(model, created_at);
create index if not exists usage_events_lead_idx          on usage_events(lead_id) where lead_id is not null;
-- Idempotencia backfill CMA: una fila por session_id (parcial → permite null en no-CMA)
create unique index if not exists usage_events_session_uniq
  on usage_events(session_id) where session_id is not null;

alter table usage_events enable row level security;
drop policy if exists authenticated_all on usage_events;
create policy authenticated_all on usage_events
  for all to authenticated using (true) with check (true);

-- Vista diaria (line/bar charts + StatCards en server component)
create or replace view usage_daily as
select
  date_trunc('day', created_at at time zone 'UTC')::date as day,
  component, model,
  count(*)                    as calls,
  sum(input_tokens)           as total_input,
  sum(output_tokens)          as total_output,
  sum(cache_read_tokens)      as total_cache_read,
  sum(estimated_cost_usd)     as total_cost_usd,
  sum(runtime_ms)             as total_runtime_ms,
  bool_or(is_estimated)       as has_estimates,
  sum(cache_creation_tokens)  as total_cache_creation
from usage_events
group by 1, 2, 3;

-- Heatmap dow×hora EN TZ DEL NEGOCIO (join follow_up_config — mismo patrón que 0021/0032)
create or replace view usage_hourly_heatmap as
select
  extract(isodow from ue.created_at at time zone cfg.timezone)::int as dow,   -- 1=Lun..7=Dom
  extract(hour   from ue.created_at at time zone cfg.timezone)::int as hour,   -- 0..23
  count(*)                  as calls,
  sum(ue.estimated_cost_usd) as cost_usd
from usage_events ue
cross join lateral (
  select timezone from follow_up_config where is_active = true limit 1
) cfg
group by 1, 2;
