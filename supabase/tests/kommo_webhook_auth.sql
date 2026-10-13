-- Prueba de la migración 0073 (autenticidad del webhook de Kommo) contra un Postgres con
-- TODAS las migraciones aplicadas:
--   · kommo_webhook_rotate: atómica, NO pisa el anterior mientras Kommo no confirmó el vigente;
--   · kommo_webhook_mark_applied: confirma solo si el secreto sigue siendo el vigente;
--   · kommo_webhook_note: confirmación por request firmada con el vigente, descartes y alertas;
--   · system_incidents ya no guarda el ?token= (barrido de la migración);
--   · permisos (solo service_role ejecuta).
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/kommo_webhook_auth.sql   (con -f: usa \\ir ../migrations)
begin;

create or replace function pg_temp.expect(p_desc text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FALLO: %', p_desc; end if;
  raise notice 'ok: %', p_desc;
end $$;

-- Estado de partida conocido.
update kommo_webhook_auth
   set mode = 'permissive', rotated_at = null, current_confirmed_at = null, previous_expires_at = null,
       last_signed_at = null, last_unsigned_at = null, last_rejected_at = null, last_rejected_reason = null
 where singleton;
delete from _app_secrets where clave = 'KOMMO_WEBHOOK_SECRET_PREVIOUS';
update _app_secrets set valor = repeat('a', 48) where clave = 'KOMMO_WEBHOOK_SECRET';
delete from alerts where kind in ('webhook_rejected', 'webhook_unsigned');

-- 1) Primera rotación: S0 → anterior, S1 vigente, anterior con 24 h.
select pg_temp.expect('rotar sin anterior vigente: ok', kommo_webhook_rotate(repeat('b', 48)) = 'ok');
select pg_temp.expect('S1 vigente y S0 anterior',
  (select valor from _app_secrets where clave = 'KOMMO_WEBHOOK_SECRET') = repeat('b', 48)
  and (select valor from _app_secrets where clave = 'KOMMO_WEBHOOK_SECRET_PREVIOUS') = repeat('a', 48));
select pg_temp.expect('rotated_at puesto, sin confirmar y anterior vence en ~24 h',
  (select rotated_at is not null and current_confirmed_at is null
          and previous_expires_at between now() + interval '23 hours' and now() + interval '25 hours'
     from kommo_webhook_auth where singleton));

-- 2) Segunda rotación SIN que Kommo confirmara S1: se rechaza y S0 NO se pierde.
select pg_temp.expect('rotar otra vez sin confirmar: pending_confirmation',
  kommo_webhook_rotate(repeat('c', 48)) = 'pending_confirmation');
select pg_temp.expect('S0 sigue como anterior y S1 vigente (nada se pisó)',
  (select valor from _app_secrets where clave = 'KOMMO_WEBHOOK_SECRET_PREVIOUS') = repeat('a', 48)
  and (select valor from _app_secrets where clave = 'KOMMO_WEBHOOK_SECRET') = repeat('b', 48));

-- 3) Una request firmada con el ANTERIOR no confirma; con el vigente, sí.
select kommo_webhook_note(true, false);
select pg_temp.expect('firmada con el anterior: sigue sin confirmar',
  (select current_confirmed_at is null and last_signed_at is not null from kommo_webhook_auth where singleton));
select pg_temp.expect('con el anterior sin confirmar se sigue rechazando',
  kommo_webhook_rotate(repeat('c', 48)) = 'pending_confirmation');
select kommo_webhook_note(true, true);
select pg_temp.expect('firmada con el vigente: confirmada',
  (select current_confirmed_at >= rotated_at from kommo_webhook_auth where singleton));
-- (cada verificación en su propia sentencia: una subconsulta de la MISMA sentencia ve la
-- foto anterior a lo que escribió la función)
select pg_temp.expect('confirmada: se puede rotar', kommo_webhook_rotate(repeat('c', 48)) = 'ok');
select pg_temp.expect('S1 pasa a anterior',
  (select valor from _app_secrets where clave = 'KOMMO_WEBHOOK_SECRET_PREVIOUS') = repeat('b', 48));

-- 4) mark_applied: solo confirma si el secreto sigue siendo el vigente.
select pg_temp.expect('mark_applied con un secreto viejo: false', kommo_webhook_mark_applied(repeat('b', 48)) = false);
select pg_temp.expect('... y no confirma', (select current_confirmed_at is null from kommo_webhook_auth where singleton));
select pg_temp.expect('mark_applied con el vigente: true', kommo_webhook_mark_applied(repeat('c', 48)) = true);
select pg_temp.expect('... y confirma', (select current_confirmed_at is not null from kommo_webhook_auth where singleton));

-- 5) Anterior vencido: rotar está permitido aunque no haya confirmación.
select kommo_webhook_rotate(repeat('d', 48));
update kommo_webhook_auth set previous_expires_at = now() - interval '1 minute' where singleton;
select pg_temp.expect('anterior vencido: se puede rotar sin confirmar', kommo_webhook_rotate(repeat('e', 48)) = 'ok');
do $$ begin
  perform kommo_webhook_rotate('corto');
  raise exception 'FALLO: aceptó un secreto corto';
exception when invalid_parameter_value then raise notice 'ok: rechaza un secreto corto';
end $$;

-- 6) Descartes: se marcan y dejan UNA alerta cada 6 h, sin el token.
select kommo_webhook_note(false, false, 'bad_token');
select kommo_webhook_note(false, false, 'unsigned_strict');
select pg_temp.expect('descarte registrado con el último motivo',
  (select last_rejected_at is not null and last_rejected_reason = 'unsigned_strict' from kommo_webhook_auth where singleton));
select pg_temp.expect('una sola alerta webhook_rejected',
  (select count(*) = 1 from alerts where kind = 'webhook_rejected'));
select pg_temp.expect('el descarte no cuenta como request sin firma ni firmada',
  (select last_unsigned_at is null from kommo_webhook_auth where singleton));
select pg_temp.expect('webhook_rejected sale por el webhook de alertas por default',
  (select 'webhook_rejected' = any(webhook_kinds) from alert_config limit 1) is not false);

-- 7) Barrido de system_incidents: el destino con ?token= queda enmascarado.
insert into system_incidents (kind, severity, title, description, remedy, resolved_at, metadata)
values ('kommo_webhook_caido', 'critical', 't', 'd', 'r', now(),
        jsonb_build_object('destination', 'https://x.supabase.co/functions/v1/kommo-webhook?token=' || repeat('f', 48)));
-- Se re-aplica la migración (es idempotente): su barrido tiene que enmascarar lo guardado.
\ir ../migrations/0073_kommo_webhook_auth.sql
select pg_temp.expect('el barrido de 0073 enmascara el token guardado',
  not exists (select 1 from system_incidents where metadata::text like '%' || repeat('f', 48) || '%')
  and exists (select 1 from system_incidents where metadata->>'destination' like '%?token=***'));

-- 8) Permisos: solo service_role ejecuta las funciones nuevas.
select pg_temp.expect('anon/authenticated no ejecutan rotate/mark_applied/note',
  not has_function_privilege('anon', 'kommo_webhook_rotate(text, int)', 'execute')
  and not has_function_privilege('authenticated', 'kommo_webhook_rotate(text, int)', 'execute')
  and not has_function_privilege('authenticated', 'kommo_webhook_mark_applied(text)', 'execute')
  and not has_function_privilege('authenticated', 'kommo_webhook_note(boolean, boolean, text)', 'execute')
  and has_function_privilege('service_role', 'kommo_webhook_rotate(text, int)', 'execute'));
select pg_temp.expect('la firma vieja kommo_webhook_note(boolean) ya no existe',
  to_regprocedure('kommo_webhook_note(boolean)') is null);

rollback;
