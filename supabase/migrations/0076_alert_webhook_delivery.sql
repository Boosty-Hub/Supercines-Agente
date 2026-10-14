-- =============================================================
-- 0076_alert_webhook_delivery.sql
-- Entrega por webhook (Slack/Discord) de TODA alerta de un tipo notificable.
--
-- Hasta acá solo se posteaban las alertas que creaban los detectores de alerts-scan
-- (postWebhook al insertar). Las que insertan otras funciones (outbound_blocked,
-- inbound_dropped, salesbot_not_delivered, provider_credit_exhausted…) o SQL
-- (webhook_unsigned, webhook_rejected) NUNCA salían, aunque su tipo estuviera en
-- alert_config.webhook_kinds. Ahora hay UN solo camino de envío (alerts-scan, también para
-- las alertas que crea él mismo):
--  · alerts.webhook_notified_at: null = pendiente de barrido. Las alertas existentes al
--    agregar la columna se marcan notificadas (no se inunda Slack con historia).
--  · alerts.webhook_posted_at: cuándo se POSTEÓ de verdad (lo marca el reclamo para las que
--    salen y alerts-scan lo vuelve a null si el POST falla). Es lo ÚNICO que cuenta el dedupe:
--    una alerta descartada por vieja, backfilleada o de un tipo no notificable nunca se
--    posteó, así que no suprime a una nueva idéntica. El backfill NO lo marca.
--  · alerts.webhook_suppressed: cerrada sin postear (vieja o idéntica a una posteada).
--  · claim_alerts_for_webhook(p_kinds, …): ver la función.
--  · webhook_kinds: default = el registro de _shared/alert-kinds.ts (el test lo verifica) y
--    los tipos nuevos de esta versión se suman a las configuraciones EXISTENTES (ver abajo).
--
-- ORDEN DE DEPLOY: aplicar esta migración ANTES de desplegar las Edge Functions de esta
-- versión. Si se invierte, nada se pierde: insertAlert (_shared/alerts.ts) no escribe
-- columnas de esta migración, y alerts-scan, sin el RPC (PGRST202), postea directo lo que
-- crea él mismo como antes; el resto de las alertas de la ventana quedan en el panel (el
-- backfill las marca notificadas al aplicar esto).
-- IDEMPOTENTE (se puede aplicar dos veces).
-- =============================================================

-- Backfill ÚNICO: solo cuando la columna se agrega por primera vez, lo que ya existe se marca
-- notificado (no se inunda Slack con historia en el rollout). Re-ejecutar no toca nada.
-- NO marca webhook_posted_at: esas alertas no se sabe si salieron, y el dedupe solo cuenta
-- las que se postearon con certeza.
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
alter table alerts add column if not exists webhook_posted_at timestamptz;
alter table alerts add column if not exists webhook_suppressed boolean not null default false;

create index if not exists alerts_webhook_pending_idx on alerts (created_at) where webhook_notified_at is null;
-- dedupe: búsqueda de una idéntica posteada en la ventana
create index if not exists alerts_webhook_posted_idx on alerts (kind, title, webhook_posted_at) where webhook_posted_at is not null;

-- Versiones previas (borrador sin desplegar) con otra firma / tipo de retorno.
drop function if exists claim_alerts_for_webhook(int, interval, interval);
drop function if exists claim_alerts_for_webhook(text[], int, interval, interval);

-- Reclama las alertas pendientes y devuelve SOLO las que hay que postear:
--  1. pg_advisory_xact_lock(hashtextextended('alerts:webhook_sweep', 73)) — clave FIJA: dos
--     barridos se SERIALIZAN (no solo no toman la misma fila: el segundo ve lo que el primero
--     marcó como posteado, así el dedupe no tiene carreras). Se libera al terminar la transacción.
--  2. Las de más de p_max_age se cierran sin postear (suprimidas: ya no son noticia).
--  3. Las de un tipo fuera de p_kinds (lo que el operador notifica) se cierran sin postear.
--  4. Rate limit: hasta p_limit pendientes por barrido, las más viejas primero (el resto espera
--     al siguiente). `for update skip locked` además del lock: no espera filas de otro escritor.
--  5. Dedupe: idéntica (tipo + título + referencia) a otra POSTEADA (webhook_posted_at) hace
--     menos de p_dedupe → suprimida. Entre idénticas del MISMO lote sale solo la más vieja, y
--     `repeated` cuenta cuántas se suprimieron con ella (el aviso dice «(+N repetidas)»).
-- Las que salen quedan con webhook_posted_at = now(): el POST es mejor esfuerzo y no se
-- reintenta; si falla, alerts-scan lo vuelve a null (no se postea dos veces una alerta, y un
-- aviso que no llegó no suprime al siguiente).
create function claim_alerts_for_webhook(
  p_kinds   text[],
  p_limit   int      default 10,
  p_max_age interval default interval '24 hours',
  p_dedupe  interval default interval '1 hour'
)
returns table (
  id          uuid,
  kind        text,
  severity    text,
  title       text,
  description text,
  ref_table   text,
  ref_id      uuid,
  created_at  timestamptz,
  repeated    int
)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('alerts:webhook_sweep', 73));

  update alerts a
     set webhook_notified_at = now(), webhook_suppressed = true
   where a.webhook_notified_at is null and a.created_at <= now() - p_max_age;

  update alerts a
     set webhook_notified_at = now()
   where a.webhook_notified_at is null and not (a.kind = any(coalesce(p_kinds, '{}'::text[])));

  return query
  with cand as (
    select a.id, a.kind, a.title, a.ref_id, a.created_at
      from alerts a
     where a.webhook_notified_at is null
     order by a.created_at, a.id
     limit greatest(p_limit, 0)
       for update skip locked
  ),
  grouped as (
    select c.*,
           row_number() over w as rn,
           (count(*) over (partition by c.kind, c.title, c.ref_id))::int as n
      from cand c
    window w as (partition by c.kind, c.title, c.ref_id order by c.created_at, c.id)
  ),
  decided as (
    select g.id, g.n,
           (g.rn > 1 or exists (
              select 1 from alerts d
               where d.kind = g.kind
                 and d.title = g.title
                 and d.ref_id is not distinct from g.ref_id
                 and d.webhook_posted_at > now() - p_dedupe)) as dup
      from grouped g
  ),
  marked as (
    update alerts a
       set webhook_notified_at = now(),
           webhook_suppressed  = d.dup,
           webhook_posted_at   = case when d.dup then null else now() end
      from decided d
     where a.id = d.id
    returning a.id, a.kind, a.severity, a.title, a.description, a.ref_table, a.ref_id, a.created_at,
              d.n - 1 as repeated, d.dup
  )
  select m.id, m.kind, m.severity, m.title, m.description, m.ref_table, m.ref_id, m.created_at, m.repeated
    from marked m
   where not m.dup
   order by m.created_at, m.id;
end;
$$;
revoke execute on function claim_alerts_for_webhook(text[], int, interval, interval) from public, anon, authenticated;
grant execute on function claim_alerts_for_webhook(text[], int, interval, interval) to service_role;

-- Tipos notificables (== webhookKindsDefault() de _shared/alert-kinds.ts; dream_error NO).
alter table alert_config
  alter column webhook_kinds
  set default array[
    'draft_failed', 'human_review_needed', 'outcomes_regression', 'inbound_silence', 'inbound_dropped',
    'kommo_webhook_disabled', 'budget_exceeded', 'outbound_blocked', 'salesbot_not_delivered',
    'provider_credit_exhausted', 'webhook_unsigned', 'webhook_rejected', 'kommo_webhook_caido',
    'kommo_token', 'ingesta_detenida', 'cola_atascada'
  ]::text[];

-- Configuraciones EXISTENTES: se suman los tipos que NO existían como notificables en la
-- versión de producción anterior (2f2ce14), sin pisar lo que el operador eligió para el resto:
--  · outbound_blocked (0069), webhook_unsigned y webhook_rejected (0070): tipos nuevos.
--  · salesbot_not_delivered y provider_credit_exhausted: ya se insertaban, pero no estaban en
--    ningún default ni se posteaban (solo salían las alertas de alerts-scan).
-- Como no existían, ningún operador pudo haberlos quitado: agregarlos no contradice ninguna
-- elección. Los que ya estaban en producción (draft_failed, human_review_needed,
-- outcomes_regression, inbound_silence, inbound_dropped, kommo_webhook_disabled,
-- budget_exceeded y los 4 incidentes de salud) NO se tocan: si el operador quitó alguno, sigue
-- quitado. array_append solo si falta → idempotente.
do $$
declare
  k text;
begin
  foreach k in array array[
    'outbound_blocked', 'webhook_unsigned', 'webhook_rejected', 'salesbot_not_delivered', 'provider_credit_exhausted'
  ]::text[] loop
    update alert_config set webhook_kinds = array_append(webhook_kinds, k) where not (k = any(webhook_kinds));
  end loop;
end $$;
