-- =============================================================
-- 0090_kommo_missing_verify.sql
-- Verificación de leads borrados en Kommo con el recorrido YA terminado.
--
-- Hasta acá los candidatos a «no existe en Kommo» (kommo_missing_candidates) solo se
-- verificaban UNA vez, al cerrar un recorrido completo, y como mucho 5000. Si quedaban
-- más (o un lote no se pudo confirmar), con el recorrido en 'done' nadie volvía a
-- mirarlos: seguían como «Sin pipeline» para siempre, salvo reiniciando el recorrido
-- entero (KIA, oct-2026: 17.199 leads borrados en Kommo). Ahora sync-pipelines, con el
-- recorrido 'done', toma un lease SIN cambiar el estado ni rebobinar nada y verifica por
-- id (con control positivo, _shared/reconcile-leads.ts) los candidatos pendientes.
--
--  · claim_kommo_missing_verify: lease sobre un recorrido 'done' libre. No toca status,
--    cursor, contadores ni updated_at (el enfriamiento del reinicio no se mueve). Con el
--    lease tomado, claim_kommo_backfill responde 'busy': un reinicio no puede vaciar
--    kommo_backfill_seen (la base de los candidatos) en medio de una verificación.
--  · renew_kommo_backfill_lease: ahora también renueva el lease de un 'done' (mismo
--    token). Seguro: save_kommo_backfill_progress('done') borra el token, así que el
--    único token vigente sobre un 'done' es el de esta verificación.
--  · release_kommo_missing_verify: suelta el lease propio (solo con el token).
--  · kommo_missing_control_ids: leads con señal de vida reciente para usar como CONTROL
--    POSITIVO en la confirmación: si Kommo devuelve el control, el vacío del resto es
--    real; si no, la respuesta no se usa para marcar.
-- Nada de esto marca por sí mismo: marcar sigue siendo solo mark_kommo_leads_missing con
-- ids confirmados, y cualquier señal de vida sigue limpiando la marca.
-- Idempotente (create or replace). Solo service_role.
-- =============================================================

create or replace function claim_kommo_missing_verify(p_job text, p_lease_seconds int default 150)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare
  v_token uuid;
begin
  update kommo_backfill k
     set lease_until = now() + make_interval(secs => p_lease_seconds),
         lease_token = gen_random_uuid()
   where k.job = p_job
     and k.status = 'done'
     and (k.lease_until is null or k.lease_until <= now())
  returning k.lease_token into v_token;
  return v_token;
end;
$$;

create or replace function release_kommo_missing_verify(p_job text, p_token uuid)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_token is null then
    return false;
  end if;
  update kommo_backfill k
     set lease_until = null,
         lease_token = null
   where k.job = p_job and k.lease_token = p_token and k.status = 'done';
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- Igual que en 0065, más 'done' (el lease de claim_kommo_missing_verify).
create or replace function renew_kommo_backfill_lease(p_job text, p_token uuid, p_lease_seconds int default 150)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_token is null then
    return false;
  end if;
  update kommo_backfill k
     set lease_until = now() + make_interval(secs => p_lease_seconds)
   where k.job = p_job and k.lease_token = p_token and k.status in ('running', 'done');
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- Controles positivos: leads con pipeline, sin marca y con la señal de vida más reciente
-- (posición fijada por un webhook, el panel o una lectura de Kommo).
create or replace function kommo_missing_control_ids(p_limit int default 10)
returns setof bigint language sql stable set search_path = public, pg_temp as $$
  select l.kommo_lead_id
    from leads l
   where l.kommo_lead_id is not null
     and l.kommo_pipeline_id is not null
     and l.kommo_missing_at is null
     and l.kommo_position_at is not null
   order by l.kommo_position_at desc, l.kommo_lead_id desc
   limit greatest(1, least(p_limit, 50))
$$;

revoke execute on function claim_kommo_missing_verify(text, int) from public, anon, authenticated;
grant execute on function claim_kommo_missing_verify(text, int) to service_role;
revoke execute on function release_kommo_missing_verify(text, uuid) from public, anon, authenticated;
grant execute on function release_kommo_missing_verify(text, uuid) to service_role;
revoke execute on function renew_kommo_backfill_lease(text, uuid, int) from public, anon, authenticated;
grant execute on function renew_kommo_backfill_lease(text, uuid, int) to service_role;
revoke execute on function kommo_missing_control_ids(int) from public, anon, authenticated;
grant execute on function kommo_missing_control_ids(int) to service_role;
