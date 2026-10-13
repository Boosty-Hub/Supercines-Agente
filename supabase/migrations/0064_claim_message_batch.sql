-- =============================================================
-- 0064_claim_message_batch.sql
-- Claim ATÓMICO del batch de mensajes — reemplaza el SELECT-y-después-marco.
--
-- PROBLEMA (medido en KIA, 18-ago-2026; el bug es del template): `generate-response`
-- corre en paralelo desde varios disparadores — el fire-and-forget del
-- webhook, el sweep de pg_cron cada minuto, el trigger de process-inbound y
-- el fan-out encadenado (`maybeFanOut`, hasta MAX_CONCURRENT). Todas las
-- invocaciones concurrentes ejecutan `pickLeadBatch` en el mismo instante,
-- ven los mismos mensajes con `answered_by_draft_id is null` y eligen el
-- MISMO lead: el marcado vivía DESPUÉS de crear el draft, como un UPDATE
-- aparte sin relación con el SELECT que lo precedió, así que llegaba tarde.
-- Medido en KIA: 5 drafts del mismo message_id en 800 ms; 256 mensajes
-- afectados y 247 respuestas duplicadas REALMENTE ENVIADAS en un solo día.
-- El cliente recibe el mismo mensaje varias veces y se paga cada sesión CMA
-- de más.
--
-- FIX: se expone el claim como RPC — una sola sentencia SQL — para que la
-- atomicidad no dependa de cómo compone el filtro el cliente (PostgREST). El
-- UPDATE con `where answered_by_draft_id is null` ES el punto de
-- serialización: los row locks de Postgres dejan ganar a una sola
-- invocación; las demás reevalúan el predicado, ven la fila ya tomada por
-- otra y actualizan 0 filas. Devuelve cuántas filas logró reclamar; el
-- llamador (generate-response/index.ts) exige el batch COMPLETO — si reclamó
-- menos, libera lo tomado, borra su draft y aborta sin loguear un error
-- falso (ver `_shared/claim-batch.ts`, que interpreta este resultado puro).
--
-- Least-privilege: Postgres da EXECUTE a PUBLIC por defecto en funciones
-- nuevas. Se revoca explícito y se otorga solo a `service_role` — la única
-- que llama esta RPC, desde generate-response. anon/authenticated no tienen
-- ninguna razón para tocar `answered_by_draft_id`.
-- IDEMPOTENTE.
-- =============================================================

create or replace function public.claim_message_batch(
  p_message_ids uuid[],
  p_draft_id uuid
)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with upd as (
    update public.messages
       set answered_by_draft_id = p_draft_id
     where id = any(p_message_ids)
       and answered_by_draft_id is null
    returning 1
  )
  select count(*)::int from upd;
$$;

revoke all on function public.claim_message_batch(uuid[], uuid) from public;
revoke all on function public.claim_message_batch(uuid[], uuid) from anon, authenticated;
grant execute on function public.claim_message_batch(uuid[], uuid) to service_role;

comment on function public.claim_message_batch(uuid[], uuid) is
  'Claim atómico del batch: marca answered_by_draft_id solo en las filas libres y devuelve cuántas ganó. Evita respuestas duplicadas al mismo lead (0064).';
