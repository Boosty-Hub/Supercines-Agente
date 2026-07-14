-- =============================================================
-- 0023_response_controls.sql
-- Controles de respuesta para personalizar cuándo el agente NO responde:
--   A. verticals.ignore       → disposición "ignorar": se clasifica el mensaje
--                               pero el agente no responde ni va a revisión.
--   B. messages.ignored        → marca por mensaje (lo setea process-inbound).
--   C. agent_skip_rules        → reglas deterministas (menciones/@etiquetas/
--                               palabras) que silencian al agente ANTES de Haiku.
--   D. kommo_publish_config    → cooldown + tope de respuestas por lead.
-- Todo additivo e idempotente.
-- =============================================================

-- ---- A. Disposición "ignorar" por vertical -------------------------------
alter table verticals
  add column if not exists ignore boolean not null default false;

-- ---- B. Marca por mensaje (el agente no lo responde) ---------------------
alter table messages
  add column if not exists ignored boolean not null default false;
alter table messages
  add column if not exists ignored_reason text;
create index if not exists messages_ignored_idx
  on messages(ignored) where ignored = true;

-- ---- C. Reglas de silencio (menciones / palabras) ------------------------
create table if not exists agent_skip_rules (
  id uuid primary key default gen_random_uuid(),
  -- Texto a buscar. Para match_type='mention_tag' puede ir vacío (= cualquier @mención).
  pattern text not null default '',
  match_type text not null default 'contains'
    check (match_type in ('contains','regex','mention_tag')),
  case_sensitive boolean not null default false,
  enabled boolean not null default true,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists agent_skip_rules_updated_at on agent_skip_rules;
create trigger agent_skip_rules_updated_at before update on agent_skip_rules
  for each row execute function set_updated_at();
create index if not exists agent_skip_rules_enabled_idx
  on agent_skip_rules(enabled) where enabled = true;

alter table agent_skip_rules enable row level security;
drop policy if exists authenticated_all on agent_skip_rules;
create policy authenticated_all on agent_skip_rules
  for all to authenticated using (true) with check (true);

-- Ejemplo deshabilitado para que el operador vea la forma de una regla.
insert into agent_skip_rules (pattern, match_type, case_sensitive, enabled, description)
select '', 'mention_tag', false, false,
       'Ejemplo: ignorar comentarios que etiquetan a alguien (ej: "@maria ganatelo"). Activalo si no querés que el agente responda etiquetas/sorteos.'
where not exists (select 1 from agent_skip_rules);

-- ---- D. Cooldown + tope de respuestas por lead ---------------------------
-- response_cooldown_seconds: segundos mínimos entre respuestas del agente al
--   MISMO lead. 0 = desactivado.
-- max_responses_per_lead: tope de respuestas por lead dentro de la ventana.
--   0 = sin tope.
-- cooldown_window_hours: ventana rodante para contar el tope. Default 24h.
alter table kommo_publish_config
  add column if not exists response_cooldown_seconds integer not null default 0;
alter table kommo_publish_config
  add column if not exists max_responses_per_lead integer not null default 0;
alter table kommo_publish_config
  add column if not exists cooldown_window_hours integer not null default 24;
