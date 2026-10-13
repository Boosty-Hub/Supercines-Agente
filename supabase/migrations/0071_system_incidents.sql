-- =============================================================
-- 0071_system_incidents.sql
-- INCIDENTES DE SISTEMA: estado vivo de las fallas que dejan al agente MUDO.
--
-- POR QUÉ UNA TABLA NUEVA Y NO `alerts`: `alerts` es un log append-only por
-- entidad (un draft que falló, un mensaje que pide review) que se marca leído
-- a mano. Un incidente de plataforma es otra cosa: es un ESTADO binario del
-- sistema (roto / sano) que se abre solo, se refresca mientras siga roto y se
-- cierra solo cuando se arregla. Con `alerts` la franja roja quedaría
-- prendida para siempre después de un apagón, o habría que apagarla a mano
-- justo cuando nadie está mirando.
--
-- Por qué esto no reemplaza a `inbound_silence` / `kommo_webhook_disabled`
-- (alerts-scan, migración 0065): esas son un LOG (una fila por aviso, se
-- consulta desde /alerts o el webhook de Slack). Esto es un BANNER — arriba
-- de TODAS las páginas, con acción de recuperación de un clic y un `remedy`
-- en lenguaje llano. Las dos leen la misma señal de Kommo por razones
-- distintas: una avisa, la otra muestra un estado accionable.
--
-- INVARIANTE: como mucho UN incidente abierto por `kind` (índice único
-- parcial). Reportar dos veces el mismo kind refresca `last_seen_at` en vez
-- de duplicar. El historial de incidentes cerrados se conserva.
--
-- IDEMPOTENTE.
-- =============================================================

create table if not exists system_incidents (
  id uuid primary key default gen_random_uuid(),
  -- 'kommo_webhook_caido' | 'kommo_token' | 'ingesta_detenida' | 'cola_atascada'
  kind text not null,
  severity text not null default 'critical'
    check (severity in ('warning','critical')),
  title text not null,
  description text,
  -- Qué hacer para arreglarlo. Se muestra en la franja roja: el operador no
  -- tiene por qué saber qué significa un 401 de la API de Kommo.
  remedy text,
  metadata jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  -- Se refresca en cada detección mientras el incidente siga vivo. Permite
  -- distinguir "sigue roto ahora" de "se detectó hace 3 horas y no sabemos".
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- Silenciar la franja sin cerrar el incidente (el operador ya sabe y está
  -- resolviéndolo). Al vencer, la franja vuelve sola.
  muted_until timestamptz,
  muted_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Un solo incidente ABIERTO por kind. Es lo que hace que reportIncident()
-- pueda llamarse en cada barrido sin inflar la tabla.
create unique index if not exists system_incidents_kind_abierto_idx
  on system_incidents (kind) where resolved_at is null;

create index if not exists system_incidents_abiertos_idx
  on system_incidents (detected_at desc) where resolved_at is null;

alter table system_incidents enable row level security;
drop policy if exists authenticated_all on system_incidents;
create policy authenticated_all on system_incidents
  for all to authenticated using (true) with check (true);

-- ---- Índice para el detector de ingesta ----
-- El chequeo "¿hace cuánto que no entra un mensaje?" es un
-- `order by created_at desc limit 1`. Sin este índice, Postgres ordena la
-- tabla ENTERA y la consulta puede expirar por statement timeout — justo
-- durante un apagón, que es cuando más filas tiene acumuladas la tabla.
--
-- Los índices que ya existen no sirven acá: `messages_failed_classification_idx`
-- (migración 0056) filtra además por `vertical_id is null`, y el resto son
-- compuestos por lead_id. Ninguno permite recorrer created_at global por
-- dirección sin ese filtro extra.
create index if not exists messages_inbound_recientes_idx
  on messages (created_at desc)
  where direction = 'inbound';

-- ---- Config del barrido ----
-- Umbrales configurables: cada operador tiene su propio ritmo de mensajes y
-- un umbral fijo daría falsos positivos de madrugada.
alter table alert_config
  add column if not exists health_scan_enabled boolean not null default true;
-- Minutos sin ningún mensaje inbound para dar la ingesta por muerta. 45 min:
-- el pico normal de una cuenta activa mete varios por hora, pero de
-- madrugada puede haber huecos largos legítimos.
alter table alert_config
  add column if not exists ingesta_stale_minutes integer not null default 45;
-- Items en 'processing' más viejos que esto = runs muertos (la función se
-- cortó a mitad). 15 min es holgado: un process-inbound normal tarda segundos.
alter table alert_config
  add column if not exists cola_atascada_minutes integer not null default 15;
alter table alert_config
  add column if not exists cola_atascada_threshold integer not null default 50;

-- Los incidentes de sistema también deben poder disparar el webhook externo
-- (Slack/Discord), igual que los kinds de `alerts`. Se agregan al default y a
-- las filas ya existentes sin pisar lo que el operador haya elegido — mismo
-- idioma que 0065_alert_kinds_webhook.sql.
alter table alert_config
  alter column webhook_kinds
  set default array[
    'draft_failed',
    'human_review_needed',
    'outcomes_regression',
    'inbound_silence',
    'budget_exceeded',
    'inbound_dropped',
    'kommo_webhook_disabled',
    'outbound_blocked',
    'kommo_webhook_caido',
    'kommo_token',
    'ingesta_detenida',
    'cola_atascada'
  ]::text[];

update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'kommo_webhook_caido')
 where not ('kommo_webhook_caido' = any(webhook_kinds));

update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'kommo_token')
 where not ('kommo_token' = any(webhook_kinds));

update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'ingesta_detenida')
 where not ('ingesta_detenida' = any(webhook_kinds));

update alert_config
   set webhook_kinds = array_append(webhook_kinds, 'cola_atascada')
 where not ('cola_atascada' = any(webhook_kinds));

-- ---- Cron: cada minuto ----
-- Un apagón de ingesta cuesta leads perdidos que Kommo NO reenvía. Cada
-- minuto es barato (la función sale temprano si todo está sano) y acota la
-- ventana de ceguera a 60 segundos.
create or replace function trigger_health_scan()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Guard (estándar de seguridad de Boosty): SECURITY DEFINER bypasea la RLS. Solo
  -- service_role, pg_cron y el dueño (sin claims de usuario en la petición) pueden ejecutarla; un
  -- usuario con JWT (anon/authenticated) no, aunque algún día alguien le re-otorgue
  -- EXECUTE por error.
  if public.end_user_request() then
    raise exception 'insufficient_privilege' using errcode = 'insufficient_privilege';
  end if;
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/health-scan',
    headers := internal_function_headers(),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

revoke execute on function trigger_health_scan() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'health-scan-sweep') then
    perform cron.schedule(
      'health-scan-sweep',
      '* * * * *',
      $cron$select trigger_health_scan();$cron$
    );
  end if;
end$$;

-- Realtime: la franja roja aparece y desaparece sin que el operador recargue.
do $$
begin
  alter publication supabase_realtime add table system_incidents;
exception
  when duplicate_object then null;
end$$;
