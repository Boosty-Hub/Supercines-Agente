-- =============================================================
-- 0053_inbound_queue_reaper.sql
-- Reaper de filas atascadas en 'processing' + claim que las recupera.
--
-- PROBLEMA (medido en KIA, 2026-08-13; el bug es del template): `claim_inbound_batch` marca
-- las filas como 'processing' y NADIE las vuelve a mirar. Si el worker muere
-- a mitad del batch — límite de wall clock del edge runtime, OOM, o un 502/504
-- de PostgREST bajo carga — la fila queda 'processing' PARA SIEMPRE: no la
-- toma el claim (que solo mira 'pending') y no la reintenta el cron.
-- Resultado: 758 filas atascadas, con 326 mensajes INCOMING de clientes
-- que nunca entraron a `messages` ni recibieron respuesta. Los picos de filas
-- atascadas (jul-24: 23, jul-25: 460, jul-29: 22, ago-6: 193, ago-12: 54)
-- caen exactamente sobre los apagones del webhook.
--
-- FIX:
--   1. `claimed_at` — cuándo se tomó la fila (distinto de created_at, que es
--      cuándo llegó el webhook). Sin esto no se puede saber si un 'processing'
--      está vivo o muerto.
--   2. El claim recupera los 'processing' huérfanos de entre 10min y 24h.
--      10 minutos es DEFINITIVO: el wall clock máximo de una Edge Function es
--      ~400s (6.7min), así que nada que lleve 10 minutos en 'processing' sigue
--      vivo. Reprocesar es seguro: el dedupe por `kommo_message_id` (0050)
--      evita duplicar mensajes.
--   3. Los 'processing' de MÁS de 24h NO se reinyectan: replayarlos mandaría
--      respuestas del agente a conversaciones de hace semanas. Se marcan
--      'failed' con motivo explícito — quedan visibles y recuperables a mano.
--   4. Cap de reintentos (5) para que un payload venenoso no cicle infinito.
--
-- Se mantiene la MISMA firma `claim_inbound_batch(int)`: agregar un parámetro
-- crearía una SOBRECARGA y las llamadas de un argumento seguirían resolviendo
-- a la versión vieja (rota).
-- IDEMPOTENTE.
-- =============================================================

alter table inbound_queue
  add column if not exists claimed_at timestamptz;

-- El claim ahora filtra por claimed_at sobre las filas 'processing'.
-- El índice parcial de 0001 (inbound_queue_pending_idx, sobre created_at para
-- 'pending'/'processing') ya cubre el orden; este agrega el corte por antigüedad
-- del claim sin escanear las 176k+ filas 'done'.
create index if not exists inbound_queue_stale_processing_idx
  on inbound_queue (claimed_at)
  where status = 'processing';

create or replace function claim_inbound_batch(p_limit int default 20)
returns table (id uuid, payload jsonb) language plpgsql as $$
declare
  -- Más allá del wall clock máximo de una Edge Function (~400s): un
  -- 'processing' más viejo que esto está muerto con certeza.
  v_stale   constant interval := interval '10 minutes';
  -- Más allá de esto NO se reprocesa: mandaría respuestas a conversaciones
  -- que ya se enfriaron.
  v_abandon constant interval := interval '24 hours';
  v_max_attempts constant int := 5;
begin
  -- 1) Huérfanos irrecuperables: demasiado viejos o sin reintentos restantes.
  --    Se marcan 'failed' (visibles en el dashboard) en vez de quedar
  --    invisibles en 'processing' para siempre.
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
       or q.attempts >= v_max_attempts
     );

  -- 2) Claim: 'pending' + 'processing' huérfanos todavía recuperables.
  return query
  with claimed as (
    select q.id
      from inbound_queue q
     where q.status = 'pending'
        or (
          q.status = 'processing'
          and coalesce(q.claimed_at, q.created_at) < now() - v_stale
          and coalesce(q.claimed_at, q.created_at) >= now() - v_abandon
          and q.attempts < v_max_attempts
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
   returning q.id, q.payload;
end;
$$;
