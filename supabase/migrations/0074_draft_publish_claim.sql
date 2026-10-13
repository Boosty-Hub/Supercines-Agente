-- =============================================================
-- 0074 — Reserva atómica por draft al publicar en Kommo (a lo sumo un envío)
-- =============================================================
-- PROBLEMA: publish-to-kommo tomaba los drafts `approved` con un SELECT y los
-- publicaba (PATCH del campo + salesbot + verificación de entrega de hasta 12 s)
-- ANTES de responder. Dos fallas que terminaban en un WhatsApp DUPLICADO al cliente:
--   1. Sin reserva: el barrido de pg_cron (cada minuto), el disparo del panel al
--      aprobar y el de generate-response leían el MISMO draft `approved` y lo
--      enviaban cada uno.
--   2. Muerte a mitad: el llamador corta (panel: 4 s; pg_net: 30 s) y el runtime
--      mata la función; el draft seguía `approved` aunque el salesbot ya hubiera
--      salido, y el siguiente barrido lo reenviaba.
--
-- SOLUCIÓN (máquina de estados del envío):
--   approved ──claim_draft_for_publish──▶ publishing (dueño + lease)
--   publishing ──mark_draft_publish_sending──▶ publishing + publish_sending_at
--        (write-ahead: se marca ANTES del primer salesbot; sin esta marca no se
--         dispara nada hacia el cliente)
--   publishing ──(publish-to-kommo, con guarda de dueño)──▶ auto_sent | failed |
--        pending (guard de fuga) | rejected (vencido)
--   publishing con lease VENCIDO (worker muerto) ──recover_dead_draft_publishes──▶
--        · sin publish_sending_at → nada salió hacia el cliente → vuelve a `approved`
--          (reintento seguro; tras 3 reservas muertas → `failed`, para no ciclar)
--        · con publish_sending_at → el mensaje PUDO haber salido → NUNCA se reenvía:
--          lo retoma un worker solo para RESOLVERLO (verifica en Kommo si apareció un
--          saliente nuevo respecto de publish_baseline → auto_sent; si no se puede
--          confirmar → failed + alerta para revisión humana).
--
-- El lease (10 min por defecto) es mayor que el wall clock máximo de una Edge
-- Function: cuando vence, el worker está muerto con certeza (mismo criterio que el
-- reaper de claim_inbound_batch).
--
-- IDEMPOTENTE: add column if not exists, drop/add constraint, create or replace.
-- =============================================================

alter table drafts add column if not exists publish_owner uuid;
alter table drafts add column if not exists publish_claimed_at timestamptz;
alter table drafts add column if not exists publish_lease_until timestamptz;
alter table drafts add column if not exists publish_sending_at timestamptz;
alter table drafts add column if not exists publish_baseline text[];
alter table drafts add column if not exists publish_attempts int not null default 0;

comment on column drafts.publish_owner is
  'Worker (uuid por invocación de publish-to-kommo) que tiene reservado el draft mientras status = publishing.';
comment on column drafts.publish_lease_until is
  'Vencimiento de la reserva. Vencido = el worker murió (el lease supera el wall clock de una Edge Function).';
comment on column drafts.publish_sending_at is
  'Write-ahead: se fija ANTES del primer salesbot. Si está, el mensaje pudo haber salido y el draft NO se reenvía.';
comment on column drafts.publish_baseline is
  'IDs de eventos outgoing_chat_message del lead antes de disparar el salesbot del DM (null = no se tomó).';
comment on column drafts.publish_attempts is
  'Cantidad de reservas tomadas. Corta el ciclo de un draft que mata al worker antes de enviar.';

-- Nuevo estado `publishing`.
alter table drafts drop constraint if exists drafts_status_check;
alter table drafts add constraint drafts_status_check
  check (status in ('pending', 'approved', 'publishing', 'sent', 'rejected', 'auto_sent', 'failed'));

-- Un draft `publishing` siempre tiene dueño y vencimiento (si no, nadie lo recuperaría).
alter table drafts drop constraint if exists drafts_publishing_lease_check;
alter table drafts add constraint drafts_publishing_lease_check
  check (status <> 'publishing' or (publish_owner is not null and publish_lease_until is not null));

create index if not exists drafts_publishing_lease_idx
  on drafts (publish_lease_until) where status = 'publishing';

-- -------------------------------------------------------------
-- claim_draft_for_publish: reserva UN draft `approved` (el más viejo) para p_owner.
-- `for update skip locked` + la guarda `status = 'approved'` en el UPDATE: de dos
-- reservas concurrentes del mismo draft (cron vs. panel) gana UNA; la otra recibe
-- el siguiente draft o null.
-- -------------------------------------------------------------
create or replace function claim_draft_for_publish(
  p_owner         uuid,
  p_lease_seconds int         default 600,
  p_publish_from  timestamptz default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  if p_owner is null or p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'claim_draft_for_publish: p_owner y p_lease_seconds > 0 son obligatorios'
      using errcode = 'invalid_parameter_value';
  end if;

  with c as (
    select id from drafts
     where status = 'approved'
       and sent_at is null
       and (p_publish_from is null or created_at >= p_publish_from)
     order by created_at, id
     limit 1
     for update skip locked
  )
  update drafts d
     set status              = 'publishing',
         publish_owner       = p_owner,
         publish_claimed_at  = clock_timestamp(),
         publish_lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
         publish_sending_at  = null,
         publish_baseline    = null,
         publish_attempts    = d.publish_attempts + 1
    from c
   where d.id = c.id
     and d.status = 'approved'
  returning d.id into v_id;

  return v_id;
end;
$$;
revoke execute on function claim_draft_for_publish(uuid, int, timestamptz) from public, anon, authenticated;
grant execute on function claim_draft_for_publish(uuid, int, timestamptz) to service_role;

-- -------------------------------------------------------------
-- mark_draft_publish_sending: write-ahead ANTES de cada salesbot. Solo el dueño, con
-- el lease VIGENTE: si el lease venció (el worker se demoró y el draft pudo haber sido
-- recuperado por otro) devuelve false y el llamador NO envía nada.
-- Se puede llamar dos veces (respuesta pública a un comentario y luego el DM): la
-- primera fija publish_sending_at; la segunda solo actualiza publish_baseline.
-- -------------------------------------------------------------
create or replace function mark_draft_publish_sending(
  p_id       uuid,
  p_owner    uuid,
  p_baseline text[] default null
)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  update drafts
     set publish_sending_at = coalesce(publish_sending_at, clock_timestamp()),
         publish_baseline   = p_baseline
   where id = p_id
     and status = 'publishing'
     and publish_owner = p_owner
     and publish_lease_until > clock_timestamp();
  return found;
end;
$$;
revoke execute on function mark_draft_publish_sending(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function mark_draft_publish_sending(uuid, uuid, text[]) to service_role;

-- -------------------------------------------------------------
-- recover_dead_draft_publishes: barre los `publishing` con lease vencido.
--   requeued  → nunca llegó a marcar el envío: vuelve a `approved` (se reintenta).
--   gave_up   → ídem pero ya murió p_max_attempts veces: `failed` con el motivo.
--   resolve   → marcó el envío: p_owner lo retoma (lease nuevo) SOLO para resolverlo
--               (verificar entrega → auto_sent, o failed + alerta). Nunca se reenvía.
-- -------------------------------------------------------------
create or replace function recover_dead_draft_publishes(
  p_owner         uuid,
  p_lease_seconds int default 600,
  p_limit         int default 20,
  p_max_attempts  int default 3
)
returns table (draft_id uuid, action text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  if p_owner is null or p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'recover_dead_draft_publishes: p_owner y p_lease_seconds > 0 son obligatorios'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 1) Sin marca de envío y con reintentos disponibles → `approved` otra vez.
  return query
  with dead as (
    select id from drafts
     where status = 'publishing'
       and publish_lease_until < clock_timestamp()
       and publish_sending_at is null
       and publish_attempts < p_max_attempts
     order by publish_lease_until
     limit p_limit
     for update skip locked
  )
  update drafts d
     set status = 'approved',
         publish_owner = null,
         publish_lease_until = null,
         publish_baseline = null
    from dead
   where d.id = dead.id
     and d.status = 'publishing'
     and d.publish_sending_at is null
  returning d.id, 'requeued'::text;

  -- 2) Sin marca de envío pero agotó los reintentos → `failed` (no cicla para siempre).
  return query
  with dead as (
    select id from drafts
     where status = 'publishing'
       and publish_lease_until < clock_timestamp()
       and publish_sending_at is null
       and publish_attempts >= p_max_attempts
     order by publish_lease_until
     limit p_limit
     for update skip locked
  )
  update drafts d
     set status = 'failed',
         publish_owner = null,
         publish_lease_until = null,
         publish_baseline = null,
         agent_metadata = coalesce(d.agent_metadata, '{}'::jsonb) || jsonb_build_object(
           'publish_error',
           format('la publicación se interrumpió %s veces antes de enviar; no se reintenta más', d.publish_attempts),
           'publish_interrupted', true)
    from dead
   where d.id = dead.id
     and d.status = 'publishing'
     and d.publish_sending_at is null
  returning d.id, 'gave_up'::text;

  -- 3) Con marca de envío → se retoma solo para resolver (NUNCA vuelve a `approved`).
  return query
  with dead as (
    select id from drafts
     where status = 'publishing'
       and publish_lease_until < clock_timestamp()
       and publish_sending_at is not null
     order by publish_lease_until
     limit p_limit
     for update skip locked
  )
  update drafts d
     set publish_owner = p_owner,
         publish_lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
    from dead
   where d.id = dead.id
     and d.status = 'publishing'
     and d.publish_sending_at is not null
  returning d.id, 'resolve'::text;
end;
$$;
revoke execute on function recover_dead_draft_publishes(uuid, int, int, int) from public, anon, authenticated;
grant execute on function recover_dead_draft_publishes(uuid, int, int, int) to service_role;

-- -------------------------------------------------------------
-- Defensa en profundidad: un usuario del panel (petición con JWT) no puede mover
-- un draft que se está enviando ni "des-enviar" uno enviado. Las rutas del panel ya
-- filtran por estado (409); esto cubre cualquier camino futuro que lo olvide —
-- aprobar de nuevo un draft `publishing`/`auto_sent` lo volvería a `approved` y se
-- enviaría DOS veces. Las Edge Functions (service_role, sin claims de usuario) no
-- pasan por este freno.
-- SECURITY DEFINER: end_user_request() no tiene EXECUTE para authenticated (0061, 0070).
-- -------------------------------------------------------------
create or replace function drafts_guard_in_flight()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.end_user_request() then
    return new;
  end if;
  if old.status = 'publishing'
     and (new.status is distinct from old.status
          or new.body is distinct from old.body
          or new.edited_body is distinct from old.edited_body) then
    raise exception 'el borrador % se está enviando; no se puede modificar', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if old.status in ('sent', 'auto_sent') and new.status is distinct from old.status then
    raise exception 'el borrador % ya se envió; no se puede cambiar su estado', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;
revoke execute on function drafts_guard_in_flight() from public, anon, authenticated;
grant execute on function drafts_guard_in_flight() to service_role;

drop trigger if exists drafts_guard_in_flight on drafts;
create trigger drafts_guard_in_flight
  before update on drafts
  for each row
  when (old.status in ('publishing', 'sent', 'auto_sent'))
  execute function drafts_guard_in_flight();
