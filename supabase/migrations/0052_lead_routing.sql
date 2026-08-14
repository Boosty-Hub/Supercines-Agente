-- =============================================================
-- 0052_lead_routing.sql
-- MÓDULO — Ruteo automático de leads al equipo comercial.
--
-- Resuelve dos pedidos que van juntos:
--   1. Clasificar en una vertical propia los leads de un embudo comercial
--      (ej: "alquiler de salas") y estampar ese dato en un campo de Kommo.
--   2. Asignar el RESPONSABLE del lead en Kommo: por término detectado en el
--      texto (ej: la sede) y, cuando no se detecta ninguno, por ROUND ROBIN
--      equitativo entre el equipo.
--
-- Y desbloquea el caso real: los canales silenciados (ignored_channels) hoy ni
-- siquiera se CLASIFICAN — el mensaje se marca ignored antes de llegar a Haiku.
-- classify_only_channels separa las dos ideas: "no le respondo" ≠ "no lo miro".
--
-- Todo genérico y editable desde el dashboard: nada de IDs de un cliente
-- concreto quemados acá. El seed de asesoras/sedes se hace desde la UI.
--
-- IDEMPOTENTE: add column if not exists + create table if not exists +
-- create or replace function.
-- =============================================================

-- ---- A. Canales "clasificar sin responder" ------------------------------
-- Semántica: un canal en classify_only_channels DEBE estar además en
-- ignored_channels. La combinación significa "clasificá y ruteá el mensaje,
-- pero el agente NO le escribe al lead". Un canal que está solo acá (sin estar
-- en ignored_channels) no cambia nada: ya se clasifica y se responde.
alter table kommo_publish_config
  add column if not exists classify_only_channels text[] not null default '{}'::text[];

-- ---- B. Switches del ruteo (mismo singleton is_active=true) --------------
-- routing_enabled: kill switch del módulo. Default FALSE — un deploy no empieza
--   a mover responsables en el CRM de nadie sin que el operador lo prenda.
-- routing_takeover_user_ids: IDs de usuario de Kommo que NO cuentan como dueño
--   real (ej: la cuenta genérica de la empresa con la que entran los leads).
--   Si el responsable actual es NULL o está en esta lista → podemos asignar.
--   Si es cualquier otro (una asesora ya trabajando el lead) → NO se toca.
alter table kommo_publish_config
  add column if not exists routing_enabled boolean not null default false;
alter table kommo_publish_config
  add column if not exists routing_takeover_user_ids bigint[] not null default '{}'::bigint[];

-- ---- C. Qué vertical dispara el ruteo, y qué estampa en Kommo ------------
-- auto_assign: al clasificar en esta vertical, asignar responsable.
-- kommo_field_name / kommo_field_value: campo del LEAD a completar, POR NOMBRE
--   (misma filosofía que mover_etapa/actualizar_lead en 0028: nombres, no IDs,
--   para que el template sea portable entre clones). Si el campo es de tipo
--   select, el valor se resuelve contra sus enums; si es de texto, se escribe
--   literal. Ambos NULL = no se escribe nada.
alter table verticals
  add column if not exists auto_assign boolean not null default false;
alter table verticals
  add column if not exists kommo_field_name text;
alter table verticals
  add column if not exists kommo_field_value text;

-- ---- D. El equipo entre el que se rutea ---------------------------------
-- match_terms: términos que, si aparecen en el texto del lead, mandan el lead
--   directo a esta persona (ej: sus sedes o ciudades). El match se hace
--   normalizado (minúsculas, sin acentos) del lado de la Edge Function.
--   Vacío = esta persona solo entra por round robin.
-- sort_order: orden estable de la rueda del round robin.
create table if not exists routing_assignees (
  id             uuid primary key default gen_random_uuid(),
  kommo_user_id  bigint not null unique,
  display_name   text,
  match_terms    text[] not null default '{}'::text[],
  enabled        boolean not null default true,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
drop trigger if exists routing_assignees_updated_at on routing_assignees;
create trigger routing_assignees_updated_at before update on routing_assignees
  for each row execute function set_updated_at();
create index if not exists routing_assignees_enabled_idx
  on routing_assignees(sort_order, kommo_user_id) where enabled = true;

-- ---- E. Puntero del round robin (uno por clave; la clave es la vertical) --
create table if not exists routing_state (
  key            text primary key,
  last_user_id   bigint,
  updated_at     timestamptz not null default now()
);

-- ---- F. Auditoría: por qué este lead terminó con esta persona ------------
-- Sin esto el round robin es una caja negra y ante el primer "a mí no me llegó
-- ninguno" no hay con qué responder.
create table if not exists lead_routing_events (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid references leads(id) on delete cascade,
  kommo_lead_id     bigint,
  message_id        uuid references messages(id) on delete set null,
  vertical_slug     text,
  strategy          text not null check (strategy in ('term_match','round_robin','skipped','failed')),
  matched_term      text,
  assignee_user_id  bigint,
  previous_user_id  bigint,
  field_written     text,
  ok                boolean not null default true,
  detail            text,
  created_at        timestamptz not null default now()
);
create index if not exists lead_routing_events_lead_idx
  on lead_routing_events(lead_id, created_at desc);
create index if not exists lead_routing_events_created_idx
  on lead_routing_events(created_at desc);

-- ---- G. Marca de ruteo en el lead (idempotencia) -------------------------
-- Un lead se rutea UNA vez. Sin esto, cada mensaje nuevo del mismo lead volvía
-- a girar la rueda del round robin y a pisar al responsable que ya lo atendía.
alter table leads
  add column if not exists routed_at timestamptz;
alter table leads
  add column if not exists routed_user_id bigint;
create index if not exists leads_routed_idx on leads(routed_at) where routed_at is not null;

-- ---- H. RLS (espeja verticals: authenticated total, service_role bypassa) -
alter table routing_assignees    enable row level security;
alter table routing_state        enable row level security;
alter table lead_routing_events  enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['routing_assignees','routing_state','lead_routing_events']) loop
    execute format(
      'drop policy if exists authenticated_all on %I;
       create policy authenticated_all on %I
         for all to authenticated using (true) with check (true);',
      t, t
    );
  end loop;
end$$;

-- ---- I. Round robin ATÓMICO ---------------------------------------------
-- Dos inbounds simultáneos leyendo el puntero y escribiéndolo después es la
-- forma clásica de que un round robin casero le dé el mismo lead a la misma
-- persona dos veces. El SELECT ... FOR UPDATE serializa la rueda por clave.
--
-- Devuelve el kommo_user_id que toca, o NULL si no hay assignees habilitados.
-- Robusto ante cambios del equipo: si el último asignado ya no existe o quedó
-- deshabilitado, arranca de nuevo por el primero.
create or replace function public.next_round_robin_assignee(p_key text)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_last bigint;
  v_next bigint;
begin
  insert into routing_state (key, last_user_id)
  values (p_key, null)
  on conflict (key) do nothing;

  -- Serializa la rueda: cualquier otra transacción con la misma clave espera acá.
  select last_user_id into v_last
  from routing_state
  where key = p_key
  for update;

  with ordered as (
    select kommo_user_id,
           row_number() over (order by sort_order, kommo_user_id) as rn,
           count(*) over () as total
    from routing_assignees
    where enabled
  )
  select o.kommo_user_id into v_next
  from ordered o
  where o.rn = (
    coalesce((select p.rn from ordered p where p.kommo_user_id = v_last), 0)
      % (select max(t.total) from ordered t)
  ) + 1;

  if v_next is null then
    return null;
  end if;

  update routing_state
  set last_user_id = v_next, updated_at = now()
  where key = p_key;

  return v_next;
end;
$$;

-- Postgres da EXECUTE a PUBLIC por default: hay que sacárselo explícitamente.
-- La rueda la giran las Edge Functions (service_role) y, si algún día hace
-- falta, el dashboard (authenticated). anon nunca.
revoke all on function public.next_round_robin_assignee(text) from public;
revoke all on function public.next_round_robin_assignee(text) from anon;
grant execute on function public.next_round_robin_assignee(text) to service_role, authenticated;

comment on function public.next_round_robin_assignee(text) is
  'Devuelve el siguiente kommo_user_id de routing_assignees en round robin atómico para la clave dada (normalmente el slug de la vertical). NULL si no hay assignees habilitados.';
comment on table routing_assignees is
  'Equipo entre el que se rutean los leads. match_terms manda el lead directo (ej: sede/ciudad); sin match entra el round robin.';
comment on column kommo_publish_config.classify_only_channels is
  'Canales que se CLASIFICAN y RUTEAN pero a los que el agente NO responde. Deben estar también en ignored_channels.';
