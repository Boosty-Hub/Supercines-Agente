-- =============================================================
-- 0076_alert_webhook_delivery.sql
-- Entrega por webhook (Slack/Discord) de TODA alerta de un tipo notificable.
--
-- Hasta acá solo se posteaban las alertas que creaban los detectores de alerts-scan
-- (postWebhook al insertar). Las que insertan otras funciones (outbound_blocked,
-- inbound_dropped, salesbot_not_delivered, provider_credit_exhausted…) o SQL
-- (webhook_unsigned, webhook_rejected) NUNCA salían, aunque su tipo estuviera en
-- alert_config.webhook_kinds. Ahora:
--  · alerts.webhook_notified_at: null = pendiente de barrido. Las alertas existentes se
--    marcan notificadas (no se inunda Slack con historia en el rollout).
--  · claim_alerts_for_webhook(): reclama de forma ATÓMICA (for update skip locked: dos
--    barridos superpuestos no toman la misma) hasta p_limit alertas pendientes recientes,
--    las marca, y devuelve solo las que hay que postear. Rate limit = p_limit por barrido
--    (el resto espera al siguiente); las de más de p_max_age se descartan sin postear;
--    una alerta idéntica (mismo tipo + título + referencia) a otra ya posteada hace
--    menos de p_dedupe se marca suprimida y no se posta.
--  · webhook_kinds: default = el registro de _shared/alert-kinds.ts (el test lo verifica);
--    se suman los tipos nuevos a las configuraciones existentes sin pisar lo elegido.
-- IDEMPOTENTE.
-- =============================================================

-- Backfill ÚNICO: solo cuando la columna se agrega por primera vez, lo que ya existe se marca
-- notificado (no se inunda Slack con historia en el rollout). Re-ejecutar no toca nada.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'alerts' and column_name = 'webhook_notified_at'
  ) then
    alter table alerts add column webhook_notified_at timestamptz;
    update alerts set webhook_notified_at = now();
  end if;
end $$;
alter table alerts add column if not exists webhook_suppressed boolean not null default false;

create index if not exists alerts_webhook_pending_idx on alerts (created_at) where webhook_notified_at is null;

create or replace function claim_alerts_for_webhook(
  p_limit   int      default 10,
  p_max_age interval default interval '24 hours',
  p_dedupe  interval default interval '1 hour'
)
returns setof alerts
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;

  -- Las demasiado viejas ya no son noticia: se cierran sin postear.
  update alerts
     set webhook_notified_at = now(), webhook_suppressed = true
   where webhook_notified_at is null and created_at <= now() - p_max_age;

  return query
  with cand as (
    select a.id
      from alerts a
     where a.webhook_notified_at is null
     order by a.created_at, a.id
     limit greatest(p_limit, 0)
       for update skip locked
  ),
  marked as (
    update alerts a
       set webhook_notified_at = now(),
           -- idéntica a una ya posteada dentro de la ventana de dedupe → suprimida
           webhook_suppressed = (
             exists (
               select 1 from alerts d
                where d.id <> a.id
                  and d.kind = a.kind
                  and d.title = a.title
                  and d.ref_id is not distinct from a.ref_id
                  and d.webhook_notified_at is not null
                  and d.webhook_suppressed = false
                  and d.webhook_notified_at > now() - p_dedupe)
             -- idéntica a otra MÁS VIEJA del mismo lote: solo sale la primera
             or exists (
               select 1 from alerts d
                 join cand c2 on c2.id = d.id
                where d.id <> a.id
                  and d.kind = a.kind
                  and d.title = a.title
                  and d.ref_id is not distinct from a.ref_id
                  and (d.created_at, d.id) < (a.created_at, a.id)))
      from cand
     where a.id = cand.id
    returning a.*
  )
  select * from marked where webhook_suppressed = false order by created_at, id;
end;
$$;
revoke execute on function claim_alerts_for_webhook(int, interval, interval) from public, anon, authenticated;
grant execute on function claim_alerts_for_webhook(int, interval, interval) to service_role;

-- Tipos notificables (== webhookKindsDefault() de _shared/alert-kinds.ts; dream_error NO).
alter table alert_config
  alter column webhook_kinds
  set default array[
    'draft_failed', 'human_review_needed', 'outcomes_regression', 'inbound_silence', 'inbound_dropped',
    'kommo_webhook_disabled', 'budget_exceeded', 'outbound_blocked', 'salesbot_not_delivered',
    'provider_credit_exhausted', 'webhook_unsigned', 'webhook_rejected', 'kommo_webhook_caido',
    'kommo_token', 'ingesta_detenida', 'cola_atascada'
  ]::text[];

update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'salesbot_not_delivered')
 where not ('salesbot_not_delivered' = any(webhook_kinds));
update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'provider_credit_exhausted')
 where not ('provider_credit_exhausted' = any(webhook_kinds));
