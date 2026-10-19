-- =============================================================
-- 0091_alerts_una_por_entidad.sql
-- `draft_failed` y `human_review_needed` son alertas de UNA por entidad (un draft, un
-- mensaje): alerts-scan solo las crea si la entidad todavía no tiene una. Ese chequeo
-- (existingAlerts) iba por PostgREST, que corta la respuesta en 1.000 filas, e ignoraba
-- el error de la consulta. En cuanto las alertas de las entidades de las últimas 24 h
-- pasaban de 1.000, las que quedaban fuera del corte parecían inexistentes y se volvían
-- a crear cada 5 minutos; cada copia agrandaba la respuesta siguiente, un bucle que se
-- alimenta solo. Es la «ráfaga» de 282.428 `draft_failed` que 0055 atribuyó a falta de
-- retención, y el que en un despliegue sin esa retención (2026-10-19) llegó a 2,7
-- millones de filas y 3,1 GB y agotó el Disk IO Budget de Supabase. La retención de 0055
-- acota el daño, no lo evita: 30 días de copias alcanzan para lo mismo.
--
-- 1) Se borran las copias: queda UNA por (kind, ref_id), la ya atendida si la hay
--    (conserva quién la atendió), si no la más vieja.
-- 2) Un índice único parcial hace que la base misma rechace una copia (23505), pase lo
--    que pase con el chequeo previo del código. Los tipos son los de `onePerRef` en
--    _shared/alert-kinds.ts (alert-kinds.test.ts verifica que coincidan). Los demás tipos
--    que llevan ref_id (salesbot_not_delivered, outbound_blocked) SÍ pueden repetir
--    entidad y quedan afuera.
-- 3) Índice por (kind, created_at): las consultas de `alerts` filtran por kind
--    (provider-errors, outcomes_regression, inbound_silence…). 0055 lo descartó porque
--    `draft_failed` era el 95 % de la tabla y filtrar por kind no descartaba nada; sin las
--    copias eso deja de ser cierto.
-- Idempotente: sin copias el DELETE no borra nada, y los índices son IF NOT EXISTS.
-- =============================================================

delete from public.alerts a
using (
  select id,
         row_number() over (
           partition by kind, ref_id
           order by (acknowledged_at is null), created_at, id
         ) as rn
  from public.alerts
  where kind in ('draft_failed', 'human_review_needed')
    and ref_id is not null
) d
where a.id = d.id
  and d.rn > 1;

create unique index if not exists alerts_una_por_entidad_uidx
  on public.alerts (kind, ref_id)
  where kind in ('draft_failed', 'human_review_needed') and ref_id is not null;

create index if not exists alerts_kind_created_idx
  on public.alerts (kind, created_at desc);
