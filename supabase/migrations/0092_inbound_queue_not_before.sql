-- =============================================================
-- 0085_inbound_queue_not_before.sql
-- El primer mensaje de una conversación nueva ya no se pierde si Kommo aún no creó el lead.
--
-- PROBLEMA (Vitalicia, 2026-10-19): los `message.add` de origin `onlinechat` llegan con
-- chat_id/talk_id/contact_id pero SIN entity_id: Kommo crea el lead DESPUÉS de disparar el
-- webhook. process-inbound descartaba ese mensaje sin dejar rastro.
--
-- FIX: process-inbound intenta ubicar el lead por GET /api/v4/talks/{talk_id}; si todavía no
-- existe, devuelve la fila a 'pending' con SOLO los mensajes sin resolver y una espera
-- (`not_before`: 5 s, 10, 30, 60, 120, 180 → 7 intentos en < 7 min). Agotados, alerta
-- `inbound_lead_unresolved` (una por fila). Esta migración aporta lo que falta en la base:
--   1. `inbound_queue.not_before`: una fila 'pending' no se reclama antes de esa hora.
--   2. `inbound_queue.waiting_refs`: las conversaciones que la fila espera (`talk:<id>`,
--      `chat:<id>`, `contact:<id>`, ids validados por _shared/lead-resolver.ts). NULL = la fila
--      no espera lead. Sirve para (a) DESPERTAR la fila (not_before = now) cuando entra otro
--      mensaje del mismo talk/chat que ya trae lead, así el primero entra en el mismo lote de
--      respuesta que los siguientes en vez de quedar atrás del debounce, y (b) que
--      generate-response no responda a un lead mientras su contacto tenga una fila esperando.
--   3. claim_inbound_batch respeta `not_before` y devuelve también `attempts` (el contador
--      de intentos que decide cuándo rendirse). Mismo nombre y misma firma de argumentos
--      (p_limit int); cambia el RETURNS TABLE, por eso DROP + CREATE (como 0063). El reaper
--      usa para las filas en espera el MISMO tope que process-inbound
--      (`v_lead_max_attempts` = LEAD_RESOLVE_MAX_ATTEMPTS, test de paridad) y, si una de esas
--      filas muere procesando en su último intento, la cierra CON la alerta
--      `inbound_lead_unresolved` (nunca un 'failed' silencioso).
--   4. Tipo de alerta nuevo `inbound_lead_unresolved` (crítico, notificable, UNA por fila de la
--      cola): se suma al default de alert_config.webhook_kinds y a las configs existentes, y al
--      índice único de «una alerta por entidad» (0091). No va como `inbound_dropped`: ese tipo
--      se agrega por ventana (una fila cada 15 min con el último detalle) y mezclaba motivos y
--      perdía el talk de cada pérdida.
--   4b. Tipo `inbound_processing_failed` (crítico, notificable, UNA por fila): process-inbound lo
--      deja al agotar los reintentos de una EXCEPCIÓN de procesamiento (la fila vuelve a
--      'pending' con backoff 30/120 s, tope PROCESSING_MAX_ATTEMPTS = 3 < topes del reaper) y el
--      reaper lo deja cuando una fila SIN espera de lead muere procesando con mensajes del cliente.
--   4c. Anti-inundación (el webhook es público): `inbound_queue.signed` (lo fija kommo-webhook al
--      encolar: true = llegó con el token). Solo una fila FIRMADA deja alertas críticas POR FILA;
--      sin firma (o NULL: encolada antes de 0092) la pérdida va AGREGADA como `inbound_dropped`
--      (insert_alert_aggregated, una por ventana de 15 min), también en el reaper.
--   4d. `inbound_queue.processing_failures`: fallas de PROCESAMIENTO (excepciones) de la fila,
--      aparte de `attempts` (claims): los claims gastados esperando el lead no se comen los
--      reintentos de una excepción (PROCESSING_MAX_ATTEMPTS cuenta esta columna).
--   4e. `messages.inserted_at`: hora REAL de inserción (created_at se sella con la llegada del
--      webhook). process-inbound retoma un mensaje insertado y sin clasificar solo si tiene más
--      de RESUME_MIN_AGE_SECONDS (puede estar clasificándose en otra invocación).
--   5. Orden de deploy: ESTA migración ANTES que la función. Con la función nueva y sin 0092,
--      los UPDATE de cierre caen a uno mínimo (status, processed_at, last_error) y el reintento
--      queda 'failed' con el motivo (visible, no silencioso); kommo-webhook encola sin `signed`.
--   6. Orden de locks: primero `alerts` (el DELETE de duplicados y el índice nuevo pueden tardar
--      con muchas alertas) y AL FINAL `messages`/`inbound_queue`, así esas tablas quedan
--      bloqueadas el menor tiempo posible hasta el commit; `lock_timeout` 3 s: si una tabla
--      está ocupada la migración falla y se reintenta, en vez de encolar detrás a todo el tráfico.
-- Menor privilegio: solo service_role ejecuta la RPC (igual que 0063).
-- IDEMPOTENTE.
-- =============================================================

set local lock_timeout = '3s';

-- ---- Alertas: tipo nuevo inbound_lead_unresolved -----------------------------------------
-- Default de webhook_kinds = registro de _shared/alert-kinds.ts (alert-kinds.test.ts lo lee
-- de ACÁ: es la última migración que lo cambia).
alter table alert_config
  alter column webhook_kinds
  set default array[
    'draft_failed', 'human_review_needed', 'outcomes_regression', 'inbound_silence', 'inbound_dropped',
    'inbound_lead_unresolved', 'inbound_processing_failed', 'kommo_webhook_disabled', 'budget_exceeded', 'outbound_blocked',
    'salesbot_not_delivered', 'provider_credit_exhausted', 'webhook_unsigned', 'webhook_rejected',
    'kommo_webhook_caido', 'kommo_token', 'ingesta_detenida', 'cola_atascada', 'registro_abierto'
  ]::text[];

-- Configs existentes: el tipo es nuevo, ningún operador pudo haberlo quitado.
do $$
declare
  k text;
begin
  foreach k in array array[
    'inbound_lead_unresolved', 'inbound_processing_failed'
  ]::text[] loop
    update alert_config set webhook_kinds = array_append(webhook_kinds, k) where not (k = any(webhook_kinds));
  end loop;
end $$;

-- UNA alerta por entidad (0091) ahora incluye inbound_lead_unresolved (ref_id = fila de la
-- cola): el reaper y process-inbound no pueden duplicarla. El predicado de un índice parcial
-- no se altera: se crea el nuevo y se borra el de 0091.
delete from public.alerts a
using (
  select id,
         row_number() over (
           partition by kind, ref_id
           order by (acknowledged_at is null), created_at, id
         ) as rn
  from public.alerts
  where kind in ('draft_failed', 'human_review_needed', 'inbound_lead_unresolved', 'inbound_processing_failed')
    and ref_id is not null
) d
where a.id = d.id
  and d.rn > 1;

create unique index if not exists alerts_una_por_entidad_v2_uidx
  on public.alerts (kind, ref_id)
  where kind in ('draft_failed', 'human_review_needed', 'inbound_lead_unresolved', 'inbound_processing_failed') and ref_id is not null;

drop index if exists public.alerts_una_por_entidad_uidx;

-- ---- inbound_queue y messages (al final: menos tiempo bloqueadas) ------------------------
alter table inbound_queue
  add column if not exists not_before timestamptz;
alter table inbound_queue
  add column if not exists waiting_refs text[];
alter table inbound_queue
  add column if not exists signed boolean;
alter table inbound_queue
  add column if not exists processing_failures int not null default 0;

-- Despertar (process-inbound: `waiting_refs && …`) y diferir (generate-response: `@>`).
create index if not exists inbound_queue_waiting_refs_idx
  on inbound_queue using gin (waiting_refs)
  where waiting_refs is not null;

-- Default no volátil: las filas existentes toman la hora de la migración sin reescribir la tabla.
alter table messages
  add column if not exists inserted_at timestamptz not null default now();

drop function if exists claim_inbound_batch(int);

create function claim_inbound_batch(p_limit int default 20)
returns table (id uuid, payload jsonb, created_at timestamptz, attempts int, signed boolean, processing_failures int) language plpgsql as $$
declare
  -- Más allá del wall clock máximo de una Edge Function (~400s): un
  -- 'processing' más viejo que esto está muerto con certeza.
  v_stale   constant interval := interval '10 minutes';
  -- Más allá de esto NO se reprocesa: mandaría respuestas a conversaciones
  -- que ya se enfriaron.
  v_abandon constant interval := interval '24 hours';
  v_max_attempts constant int := 5;
  -- Filas que esperan lead (waiting_refs no null): el MISMO tope que process-inbound
  -- (LEAD_RESOLVE_MAX_ATTEMPTS en _shared/lead-resolver.ts; test de paridad). Cada espera
  -- consume un intento, así que con el tope general (5) el reaper las mataba antes de tiempo.
  v_lead_max_attempts constant int := 7;
  d record;
begin
  -- 1) Huérfanos irrecuperables (como 0052/0063). Si la fila traía mensajes del cliente, la
  --    pérdida deja alerta. El worker murió a mitad: el mensaje PUEDE haber entrado antes (por
  --    eso «puede no haber entrado»). Fila FIRMADA → una alerta por fila
  --    (inbound_lead_unresolved si esperaba lead, inbound_processing_failed si no; el índice
  --    único la deduplica con la de process-inbound). Sin firma → AGREGADA (inbound_dropped).
  for d in
    update inbound_queue q
       set status     = 'failed',
           last_error = coalesce(
             q.last_error,
             case
               when coalesce(q.claimed_at, q.created_at) < now() - v_abandon
                 then 'reaper: worker muerto, fila huérfana >24h — no se reprocesa automáticamente'
               else 'reaper: worker muerto tras ' || q.attempts || ' intentos'
             end
           )
     where q.status = 'processing'
       and coalesce(q.claimed_at, q.created_at) < now() - v_stale
       and (
         coalesce(q.claimed_at, q.created_at) < now() - v_abandon
         or q.attempts >= case when q.waiting_refs is not null then v_lead_max_attempts else v_max_attempts end
       )
    returning q.id, q.attempts, q.payload, q.waiting_refs, q.signed
  loop
    continue when not (
      jsonb_typeof(d.payload -> 'message' -> 'add') = 'array'
      and exists (
        select 1 from jsonb_array_elements(d.payload -> 'message' -> 'add') e
         where e ->> 'type' = 'incoming'
      )
    );
    if d.signed is not true then
      perform insert_alert_aggregated(
        'inbound_dropped', 'critical',
        'Se perdió un webhook de Kommo',
        'El proceso que atendía un payload SIN FIRMA murió tras ' || d.attempts
          || ' intentos. Puede no haber entrado al sistema: si es real, revisalo en Kommo.',
        'inbound_queue',
        jsonb_build_object('motivo', 'worker_muerto_sin_firma', 'cola_id', d.id, 'intentos', d.attempts),
        interval '15 minutes');
    elsif d.waiting_refs is not null then
      insert into public.alerts (kind, severity, title, description, ref_table, ref_id, metadata)
      values ('inbound_lead_unresolved', 'critical',
              'Mensaje sin lead: no se pudo ubicar la conversación en Kommo',
              'Un mensaje llegó sin lead asociado y el proceso que lo esperaba murió tras ' || d.attempts
                || ' intentos. El mensaje del cliente puede no haber entrado al sistema: revisalo en Kommo.',
              'inbound_queue', d.id,
              jsonb_build_object('motivo', 'worker_muerto', 'cola_id', d.id, 'intentos', d.attempts,
                                 'refs', to_jsonb(d.waiting_refs)))
      on conflict do nothing;
    else
      insert into public.alerts (kind, severity, title, description, ref_table, ref_id, metadata)
      values ('inbound_processing_failed', 'critical',
              'Mensaje perdido: falló el procesamiento de la cola',
              'El proceso que atendía un mensaje de un cliente murió tras ' || d.attempts
                || ' intentos. El mensaje puede no haber entrado al sistema: revisalo en Kommo.',
              'inbound_queue', d.id,
              jsonb_build_object('motivo', 'worker_muerto', 'cola_id', d.id, 'intentos', d.attempts))
      on conflict do nothing;
    end if;
  end loop;

  -- 2) Claim: 'pending' ya vencido (not_before) + 'processing' huérfanos recuperables.
  return query
  with claimed as (
    select q.id
      from inbound_queue q
     where (q.status = 'pending' and (q.not_before is null or q.not_before <= now()))
        or (
          q.status = 'processing'
          and coalesce(q.claimed_at, q.created_at) < now() - v_stale
          and coalesce(q.claimed_at, q.created_at) >= now() - v_abandon
          and q.attempts < case when q.waiting_refs is not null then v_lead_max_attempts else v_max_attempts end
        )
     order by q.created_at
     limit p_limit
       for update skip locked
  )
  update inbound_queue q
     set status     = 'processing',
         attempts   = q.attempts + 1,
         claimed_at = now()
    from claimed c
   where q.id = c.id
   returning q.id, q.payload, q.created_at, q.attempts, q.signed, q.processing_failures;
end;
$$;

revoke execute on function claim_inbound_batch(int) from public, anon, authenticated;
grant execute on function claim_inbound_batch(int) to service_role;
