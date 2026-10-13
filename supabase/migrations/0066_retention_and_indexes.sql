-- =============================================================
-- 0066_retention_and_indexes.sql
-- Retención de las tablas de alto volumen + los índices que faltaban.
--
-- TRES problemas MEDIDOS en producción, no supuestos:
--
-- 1) `evaluate-outcomes` devolvía HTTP 500 cada 5 minutos:
--       {"ok":false,"error":"drafts: canceling statement due to statement timeout"}
--    El sweep filtra por `status in ('auto_sent','sent')` y ordena por
--    `sent_at desc`, pero el único índice compuesto era
--    `drafts_status_idx (status, created_at DESC)` — sobre `created_at`, NO
--    `sent_at`. Resultado: Seq Scan de 33.764 filas (488 ms en caliente; revienta
--    el statement timeout en frío o bajo carga). NO está en el camino de
--    respuesta al lead, por eso el agente respondía igual mientras esto fallaba
--    en silencio durante semanas.
--
-- 2) CERO política de retención en ninguna tabla. Medido: la base llegó a 592 MB
--    con `inbound_queue` en 213 MB / 184.872 filas (TODAS `done`), `alerts` en
--    100 MB / 288.221 filas (282.428 de ellas `draft_failed` de una ráfaga que
--    nadie acusó nunca) y `cron.job_run_details` en 48 MB. Ese peso muerto es lo
--    que alimenta la quema de egress que dejó un proyecto restringido
--    (402 exceed_egress_quota) y tumbó el agente por completo.
--
-- 3) El dedupe de alertas hacía Seq Scan de 67.838 filas: 2.347 ms POR ALERTA
--    CREADA. NO se arregla con un índice y se probó: `(kind, created_at desc)
--    where acknowledged_at is null` lo IGNORÓ el planner (idx_scan = 0), y con
--    razón — `draft_failed` era el 95% de la tabla, así que filtrar por `kind`
--    no descarta nada, y el predicado selectivo real (`metadata->>…`, con la
--    clave parametrizada) no es indexable. La solución es que la tabla NO CREZCA:
--    por eso `draft_failed` tiene retención de 7 días y el resto 30.
--
-- Ninguna de las dos tablas purgadas tiene FKs apuntándole (verificado), así que
-- la purga no arrastra nada. Las ventanas son holgadas a propósito, para forensia.
-- IDEMPOTENTE.
-- =============================================================

-- ── 1) El índice que le faltaba al sweep de evaluate-outcomes ───────────────
create index if not exists drafts_status_sent_at_idx
  on public.drafts (status, sent_at desc);

-- ── 2) Los índices que la propia retención necesita ─────────────────────────
-- Sin esto la purga hace Seq Scan de la tabla entera en CADA lote y se muere por
-- statement timeout: `inbound_queue` solo tenía índices PARCIALES sobre
-- pending/processing, ninguno que sirviera para barrer las filas `done`.
create index if not exists inbound_queue_done_created_idx
  on public.inbound_queue (created_at) where status = 'done';
create index if not exists alerts_created_at_idx
  on public.alerts (created_at);

-- ── 3) La retención ─────────────────────────────────────────────────────────
-- Borra EN LOTES para no sostener una transacción larga sobre tablas grandes:
-- un DELETE único de 180.000 filas bloquea la tabla que el pipeline está usando.
create or replace function public.purge_retention()
returns table (tabla text, borradas bigint)
language plpgsql
security definer
set search_path = public, cron, pg_temp
as $$
declare
  n bigint;
  total bigint;
begin
  total := 0;
  loop
    delete from public.inbound_queue
    where ctid in (
      select ctid from public.inbound_queue
      where status = 'done' and created_at < now() - interval '7 days'
      limit 20000
    );
    get diagnostics n = row_count;
    total := total + n;
    exit when n = 0;
  end loop;
  tabla := 'inbound_queue'; borradas := total; return next;

  -- `draft_failed` es ruido operativo de alto volumen, 1:1 con
  -- `drafts.status='failed'` (verificado). 7 días alcanzan de sobra, y es lo que
  -- mantiene la tabla chica para que el dedupe no vuelva a costar 2 segundos.
  total := 0;
  loop
    delete from public.alerts
    where ctid in (
      select ctid from public.alerts
      where kind = 'draft_failed' and created_at < now() - interval '7 days'
      limit 20000
    );
    get diagnostics n = row_count;
    total := total + n;
    exit when n = 0;
  end loop;
  tabla := 'alerts(draft_failed)'; borradas := total; return next;

  -- El resto de las alertas conserva 30 días.
  total := 0;
  loop
    delete from public.alerts
    where ctid in (
      select ctid from public.alerts
      where created_at < now() - interval '30 days'
        -- budget_exceeded se deduplica por (mes, nivel) mirando las alertas del
        -- mes en curso: borrarla al día 30 de un mes de 31 la re-dispararía.
        and not (kind = 'budget_exceeded' and created_at > now() - interval '62 days')
      limit 20000
    );
    get diagnostics n = row_count;
    total := total + n;
    exit when n = 0;
  end loop;
  tabla := 'alerts(resto)'; borradas := total; return next;

  delete from cron.job_run_details where start_time < now() - interval '7 days';
  get diagnostics n = row_count;
  tabla := 'cron.job_run_details'; borradas := n; return next;
end;
$$;

-- SECURITY DEFINER + least-privilege: Postgres otorga EXECUTE a PUBLIC por
-- default, y esta función BORRA filas. Solo el service_role la ejecuta.
revoke all on function public.purge_retention() from public;
revoke all on function public.purge_retention() from anon, authenticated;
grant execute on function public.purge_retention() to service_role;

-- ── 4) Agendarla ────────────────────────────────────────────────────────────
-- 04:00 UTC: fuera del horario laboral de cualquier huso de América.
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'retention-purge') then
    perform cron.schedule(
      'retention-purge',
      '0 4 * * *',
      $cron$select public.purge_retention();$cron$
    );
  end if;
end$$;

-- ---- Índice del camino caliente (template 0056_hot_path_indexes) ----
-- recoverFailedClassifications (process-inbound, cada minuto) filtra por
-- direction='inbound' and vertical_id is null: sin este índice parcial descartaba
-- miles de filas por barrido. Parcial y chico a propósito (solo lo SIN clasificar).
create index if not exists messages_failed_classification_idx
  on public.messages (created_at)
  where direction = 'inbound' and vertical_id is null;
