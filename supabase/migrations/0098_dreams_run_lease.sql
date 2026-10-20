-- =============================================================
-- 0098_dreams_run_lease.sql
-- Lease atómico de la fase de ANÁLISIS de dreams-run.
--
-- El cron daily y el weekly (0010) disparan los dos a las 03:00 del domingo, y el botón
-- «Correr ahora» del panel puede caer encima de cualquiera de ellos. Dos análisis en paralelo
-- leían la misma lista de dreams registrados y escribían cada uno su versión: duplicados y
-- refrescos cruzados del mismo dream (uno archivaba el original que el otro estaba
-- reemplazando). Ahora la base decide quién analiza:
--   · claim_dreams_run(period, lease_seconds) → token si el lease estaba libre o vencido, null
--     si otra corrida lo tiene. Un único UPDATE condicional sobre una fila: de dos reclamos
--     concurrentes gana uno (el segundo re-evalúa la condición tras el lock de fila).
--   · release_dreams_run(token) → suelta el lease propio (solo con el token).
--   · El lease vence solo (acotado a 60..1800 s; dreams-run pide 600 s, más que el wall clock
--     de una Edge Function): un worker muerto no bloquea las corridas siguientes.
-- La reconstrucción del digest NO usa este lease: tiene su propio «gana la última en empezar»
-- (runtime_config.DREAMS_DIGEST_RUN). El horario del cron no cambia: la corrida que pierde
-- responde `busy` (la daily no estampa DREAMS_LAST_RUN y vuelve a intentar al día siguiente).
-- Solo service_role. Idempotente.
-- =============================================================

create table if not exists dreams_run_lease (
  id           smallint primary key default 1 check (id = 1),
  owner        uuid,
  period       text,
  leased_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table dreams_run_lease enable row level security;
revoke all on dreams_run_lease from anon, authenticated, public;
grant select, insert, update on dreams_run_lease to service_role;
insert into dreams_run_lease (id) values (1) on conflict (id) do nothing;

create or replace function claim_dreams_run(p_period text, p_lease_seconds int default 600)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare
  v_token uuid;
begin
  -- Guard (estándar de seguridad de Boosty): solo el servidor, nunca una petición con JWT de
  -- usuario, aunque alguien le re-otorgue EXECUTE.
  if end_user_request() then
    raise exception 'claim_dreams_run: solo servidor' using errcode = 'insufficient_privilege';
  end if;
  insert into dreams_run_lease (id) values (1) on conflict (id) do nothing;
  update dreams_run_lease l
     set owner        = gen_random_uuid(),
         period       = left(coalesce(p_period, ''), 20),
         leased_until = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 600), 1800))),
         updated_at   = now()
   where l.id = 1
     and (l.leased_until is null or l.leased_until <= now())
  returning l.owner into v_token;
  return v_token;
end;
$$;

create or replace function release_dreams_run(p_token uuid)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if end_user_request() then
    raise exception 'release_dreams_run: solo servidor' using errcode = 'insufficient_privilege';
  end if;
  if p_token is null then
    return false;
  end if;
  update dreams_run_lease l
     set owner = null, period = null, leased_until = null, updated_at = now()
   where l.id = 1 and l.owner = p_token;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke execute on function claim_dreams_run(text, int) from public, anon, authenticated;
grant execute on function claim_dreams_run(text, int) to service_role;
revoke execute on function release_dreams_run(uuid) from public, anon, authenticated;
grant execute on function release_dreams_run(uuid) to service_role;
