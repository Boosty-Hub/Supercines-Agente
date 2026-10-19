-- 0094_wake_waiting_rows.sql — el despertar de filas que esperan lead ya no cuesta intentos.
--
-- process-inbound despertaba (not_before = ahora) las filas de inbound_queue que esperan una
-- conversación (waiting_refs). Cada despertar adelantaba el reclamo, y el reclamo suma un
-- `attempt`: despertar una fila ajena le quemaba su backoff (7 intentos y se descarta el mensaje).
-- Ahora el despertar es esta función:
--   · a lo sumo `v_max_wakes` (3) veces por fila (`wake_count`): un flujo de despertares no puede
--     mantener una fila reclamándose para siempre;
--   · le devuelve a la fila el intento que va a gastar el reclamo del despertar
--     (attempts = greatest(attempts - 1, 0)), así despertar no acerca a la fila a su tope.
-- Solo process-inbound la llama, y solo desde filas FIRMADAS. Filtro idéntico a applyWakeFilter
-- (lead-resolver.ts): pending, sin fallas de procesamiento, esperando lead y aún con espera.
alter table inbound_queue
  add column if not exists wake_count int not null default 0;

create or replace function wake_waiting_rows(p_refs text[])
returns int language plpgsql as $$
declare
  v_max_wakes constant int := 3;
  v_n int;
begin
  update inbound_queue q
     set not_before = now(),
         wake_count = q.wake_count + 1,
         attempts   = greatest(q.attempts - 1, 0)
   where q.status = 'pending'
     and q.processing_failures = 0
     and q.last_error like 'lead_unresolved%'
     and q.waiting_refs && p_refs
     and q.not_before > now()
     and q.wake_count < v_max_wakes;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function wake_waiting_rows(text[]) from public, anon, authenticated;
grant execute on function wake_waiting_rows(text[]) to service_role;
