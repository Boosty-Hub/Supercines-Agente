-- =============================================================
-- 0058_claim_inbound_batch_created_at.sql
-- claim_inbound_batch ahora también devuelve created_at (cuándo llegó el
-- webhook a inbound_queue) además de id/payload.
--
-- PROBLEMA: con system_halted=true, kommo-webhook sigue encolando filas
-- 'pending' en inbound_queue sin límite (process-inbound corta ANTES de
-- procesar, pero el webhook nunca deja de escribir en la cola — ver
-- Deno.serve en process-inbound/index.ts). process-inbound insertaba
-- messages.created_at con now() — la hora de PROCESAMIENTO, no la de
-- LLEGADA — así que al reactivar, todo el backlog se veía "recién llegado"
-- para la ventana de frescura de generate-response (answer_max_age_hours) y
-- el agente iba a contestar mensajes de días atrás, pagando Haiku para
-- clasificar cada uno.
--
-- FIX: process-inbound necesita el created_at ORIGINAL de la fila de la cola
-- para (a) insertar messages.created_at con la hora real de llegada y (b)
-- decidir si una fila es demasiado vieja para clasificar. claim_inbound_batch
-- (0053) solo devolvía (id, payload) — CREATE OR REPLACE no permite cambiar
-- las columnas de un RETURNS TABLE, así que hace falta DROP + CREATE. Mismo
-- nombre y misma firma de argumentos que 0053 (p_limit int) — ninguna llamada
-- existente con un solo argumento deja de resolver. El resto de la lógica del
-- reaper (huérfanos 'processing' >10min recuperables hasta 24h, cap de 5
-- reintentos) queda EXACTAMENTE igual que en 0053, sin tocar.
-- IDEMPOTENTE.
-- =============================================================

drop function if exists claim_inbound_batch(int);

create function claim_inbound_batch(p_limit int default 20)
returns table (id uuid, payload jsonb, created_at timestamptz) language plpgsql as $$
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
   returning q.id, q.payload, q.created_at;
end;
$$;

-- Menor privilegio (estándar de seguridad de Boosty): Postgres le da EXECUTE a
-- PUBLIC por defecto (0006 nunca lo restringió), así que `anon`/`authenticated`
-- podían reclamar filas de la cola con la sola anon key. La única que la llama
-- es process-inbound con la key de servicio: nadie más tiene por qué poder
-- reclamar filas de la cola.
revoke execute on function claim_inbound_batch(int) from public, anon, authenticated;
grant execute on function claim_inbound_batch(int) to service_role;
