-- =============================================================
-- 0061_kommo_pipelines_board.sql
-- Base de datos del inbox tipo kanban (reflejo de los pipelines de Kommo) y de
-- la apertura rápida de conversaciones.
--
-- 1) leads.kommo_pipeline_id. La base guardaba solo la etapa, y las etapas de
--    sistema 142 (GANADO) y 143 (PERDIDO) tienen el MISMO id en TODOS los
--    pipelines: con solo la etapa no se puede ubicar un lead ganado/perdido en
--    ningún pipeline. Los webhooks leads.update / leads.status traen
--    pipeline_id; process-inbound lo guarda desde esta migración y el histórico
--    se rellena con la Edge Function `sync-pipelines` (ver punto 5).
--
-- 2) kommo_pipelines / kommo_stages: copia local de los pipelines y etapas con
--    el orden, el tipo y el color. Sin esto cada render le pediría los
--    pipelines a Kommo. PK de etapa COMPUESTA (pipeline_id, id) por 142/143.
--    Se escriben SOLO con sync_kommo_pipelines(), que reemplaza el contenido
--    entero en una transacción (una etapa borrada en Kommo desaparece acá).
--
-- 3) lead_stage_events: guarda también el pipeline (origen y destino) y el
--    nombre de quien movió el lead desde el panel. Sin el pipeline, un
--    movimiento a 142/143 es ambiguo en la línea de tiempo. Y entra en la
--    publicación de realtime para que el tablero mueva la tarjeta en vivo.
--    record_lead_stage_event() es el único camino para registrar un movimiento:
--    el agente, el panel y el webhook de Kommo reportan el MISMO movimiento (el
--    webhook es el "eco" de los otros dos) y esta función evita el duplicado
--    sin importar en qué orden lleguen.
--
-- 4) inbox_lead_summaries(): un resumen por lead (último mensaje, conteos,
--    máximos, revisión pendiente, "sin responder") calculado en la base. El
--    inbox embebía TODOS los mensajes de hasta 500 leads para calcular esto en
--    JS, en cada render. SECURITY INVOKER: la RLS aplica igual que antes.
--
-- 5) kommo_backfill + apply_kommo_lead_positions() + cron `sync-pipelines`:
--    mecanismo idempotente y reanudable para rellenar pipeline/etapa de los
--    leads que ya existían. La Edge Function `sync-pipelines` corre cada 10 min
--    desde pg_cron: refresca pipelines/etapas (1 llamada a Kommo) y, mientras
--    el backfill no esté 'done', recorre /api/v4/leads por páginas y lo avanza.
--    Cuando termina queda 'done' y el cron solo refresca pipelines.
--    Un reinicio manual («Sincronizar») lo decide la BASE, no quien llama:
--    solo se acepta con el recorrido terminado ('done') y pasado un enfriamiento
--    (15 min); un recorrido en curso nunca retrocede. Así ni un clic repetido, ni
--    varias pestañas, ni un usuario con scope `operacion` pueden mantener un
--    recrawl completo de Kommo (la cuota ~7 req/s se comparte con el webhook y
--    el agente). El freno del refresco de pipelines (30 s) también vive en la
--    base, para que valga entre instancias de la Edge Function.
--    Los leads que un recorrido COMPLETO no vio en Kommo (borrados allá) se
--    marcan con leads.kommo_missing_at: dejan de contar como trabajo pendiente
--    y el tablero los muestra aparte («No existe en Kommo»). Un webhook o un
--    movimiento exitoso de ese lead borra la marca.
--
-- 6) Orden de los eventos: leads.kommo_position_at + apply_lead_position(). Dos
--    process-inbound en paralelo (o el reaper de la cola) pueden aplicar un
--    leads.status viejo DESPUÉS de uno nuevo y dejar la etapa atrás con un
--    movimiento falso en la línea de tiempo — y la etapa gobierna los gates de
--    «etapa ignorada» de process-inbound y generate-response. apply_lead_position
--    es el ÚNICO camino que escribe la posición de un lead: un UPDATE condicional
--    bajo bloqueo de fila que solo aplica si el instante del evento (last_modified
--    del payload, o `now()` para el agente/panel/lectura en vivo) no es anterior al
--    ya guardado, y registra el movimiento solo si de verdad se aplicó.
--
-- 7) Leads sin ubicar: el recorrido de páginas (page=N) no es estable si se borra
--    un lead de Kommo mientras se lee (las páginas se corren y un lead vivo se
--    salta). Kommo NO ofrece cursor por id (solo filter[id][] y rangos por fecha),
--    así que ningún lead se declara inexistente por no aparecer en el recorrido:
--    los candidatos se VERIFICAN por id en Kommo (filter[id][], lotes) y solo los
--    que Kommo confirma ausentes se marcan. Los huecos (leads nuevos sin pipeline)
--    se completan pidiendo a Kommo SOLO esos ids, sin recorrer todo.
--
-- IDEMPOTENTE. RLS: `authenticated` solo LEE las tablas espejo (kommo_*: las
-- escribe únicamente la service key de las Edge Functions); service_role
-- bypassea. Funciones nuevas: REVOKE EXECUTE FROM PUBLIC y GRANT mínimo.
-- =============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 1) Pipeline del lead ─────────────────────────────────────────────────────
alter table leads add column if not exists kommo_pipeline_id bigint;

comment on column leads.kommo_pipeline_id is
  'Pipeline de Kommo en que está el lead. Hace falta junto a kommo_stage_id porque 142/143 (ganado/perdido) se repiten en todos los pipelines.';

-- Marca de «no existe en Kommo»: la fija el backfill SOLO cuando Kommo confirma por
-- id que el lead no existe (mark_kommo_leads_missing) y la borra cualquier señal de
-- vida (webhook, mensaje, movimiento exitoso, o volver a verlo).
alter table leads add column if not exists kommo_missing_at timestamptz;

comment on column leads.kommo_missing_at is
  'Cuándo Kommo confirmó por id que este lead no existe (borrado en Kommo). NULL = existe o no se sabe. No cuenta como pendiente de ubicar.';

-- Instante (de Kommo) del último cambio de posición aplicado. Ver apply_lead_position.
alter table leads add column if not exists kommo_position_at timestamptz;

comment on column leads.kommo_position_at is
  'Instante del evento que fijó kommo_stage_id/kommo_pipeline_id (last_modified del webhook, o now() para el agente/panel/lectura en vivo). Un evento más viejo no puede pisar la posición. NULL = nunca se fijó por evento.';

create index if not exists leads_pipeline_stage_idx
  on leads (kommo_pipeline_id, kommo_stage_id, last_message_at desc nulls last);

-- ── 2) Pipelines y etapas ────────────────────────────────────────────────────
create table if not exists kommo_pipelines (
  id          bigint primary key,
  name        text not null,
  sort        int not null default 0,
  is_main     boolean not null default false,
  is_archive  boolean not null default false,
  synced_at   timestamptz not null default now()
);

create table if not exists kommo_stages (
  pipeline_id bigint not null references kommo_pipelines(id) on delete cascade,
  id          bigint not null,
  name        text not null,
  sort        int not null default 0,
  -- Kommo: 0 = etapa normal, 1 = "Leads Entrantes" (sin ordenar).
  -- Ganado/perdido se reconocen por id (142/143), no por type.
  type        int not null default 0,
  color       text,
  synced_at   timestamptz not null default now(),
  primary key (pipeline_id, id)
);

alter table kommo_pipelines enable row level security;
alter table kommo_stages enable row level security;

drop policy if exists kommo_pipelines_read on kommo_pipelines;
create policy kommo_pipelines_read on kommo_pipelines for select to authenticated using (true);
drop policy if exists kommo_stages_read on kommo_stages;
create policy kommo_stages_read on kommo_stages for select to authenticated using (true);

-- Mínimo privilegio: son espejo de Kommo, el panel solo lee.
revoke all on kommo_pipelines, kommo_stages from anon;
revoke insert, update, delete, truncate on kommo_pipelines, kommo_stages from authenticated;

-- Reemplaza el contenido con lo que devolvió GET /api/v4/leads/pipelines.
-- p_pipelines: [{id, name, sort, is_main, is_archive, statuses:[{id,name,sort,type,color}]}]
-- Todo-o-nada: si viene vacío NO borra nada (una respuesta rara de Kommo no
-- puede dejar el tablero sin columnas).
create or replace function sync_kommo_pipelines(p_pipelines jsonb)
returns int language plpgsql set search_path = public, pg_temp as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count int;
begin
  if p_pipelines is null or jsonb_typeof(p_pipelines) <> 'array' or jsonb_array_length(p_pipelines) = 0 then
    return 0;
  end if;

  insert into kommo_pipelines (id, name, sort, is_main, is_archive, synced_at)
  select (p->>'id')::bigint, p->>'name', coalesce((p->>'sort')::int, 0),
         coalesce((p->>'is_main')::boolean, false), coalesce((p->>'is_archive')::boolean, false), v_now
    from jsonb_array_elements(p_pipelines) p
  on conflict (id) do update
    set name = excluded.name, sort = excluded.sort, is_main = excluded.is_main,
        is_archive = excluded.is_archive, synced_at = v_now;

  insert into kommo_stages (pipeline_id, id, name, sort, type, color, synced_at)
  select (p->>'id')::bigint, (s->>'id')::bigint, s->>'name', coalesce((s->>'sort')::int, 0),
         coalesce((s->>'type')::int, 0), s->>'color', v_now
    from jsonb_array_elements(p_pipelines) p,
         jsonb_array_elements(coalesce(p->'statuses', '[]'::jsonb)) s
  on conflict (pipeline_id, id) do update
    set name = excluded.name, sort = excluded.sort, type = excluded.type,
        color = excluded.color, synced_at = v_now;

  -- Lo que Kommo ya no devuelve se borró allá.
  delete from kommo_stages where synced_at < v_now;
  delete from kommo_pipelines where synced_at < v_now;

  select count(*) into v_count from kommo_stages;
  return v_count;
end;
$$;

revoke execute on function sync_kommo_pipelines(jsonb) from public, anon, authenticated;
grant execute on function sync_kommo_pipelines(jsonb) to service_role;

-- ── 3) Línea de tiempo de etapas: pipeline y actor ───────────────────────────
alter table lead_stage_events add column if not exists from_pipeline_id bigint;
alter table lead_stage_events add column if not exists pipeline_id bigint;
alter table lead_stage_events add column if not exists actor_name text;

comment on column lead_stage_events.pipeline_id is
  'Pipeline de DESTINO del movimiento (to_stage_id). Necesario porque 142/143 existen en todos los pipelines.';
comment on column lead_stage_events.from_pipeline_id is
  'Pipeline de ORIGEN del movimiento (from_stage_id).';
comment on column lead_stage_events.actor_name is
  'Quién movió el lead cuando lo hizo una persona desde el panel (moved_by = ''kommo''). NULL para el agente y para los movimientos hechos dentro de Kommo.';

-- Registro ÚNICO de un movimiento de etapa (agente, webhook de Kommo, panel).
--
-- Un mismo movimiento lo reportan DOS fuentes: quien lo hace (el agente o el
-- panel, que escriben en cuanto Kommo contesta el PATCH) y el webhook
-- leads.status que Kommo manda de vuelta. Llegan en cualquier orden. Sin esto
-- quedaban dos filas idénticas en la línea de tiempo del lead.
--
-- Si el último evento del lead ya describe el MISMO destino dentro de la
-- ventana, es el mismo movimiento: no se inserta otro, se COMPLETA el existente
-- con la fuente más informativa (el agente o la persona del panel ganan sobre
-- el "movido en Kommo" anónimo del webhook). El advisory lock por lead
-- serializa las dos fuentes para que el orden de llegada no importe.
-- DROP: se agregó p_merge_only (cambia la firma).
drop function if exists record_lead_stage_event(uuid, bigint, bigint, bigint, bigint, text, text, text, text, uuid, text, int);
create or replace function record_lead_stage_event(
  p_lead_id          uuid,
  p_from_stage_id    bigint,
  p_from_pipeline_id bigint,
  p_to_stage_id      bigint,
  p_to_pipeline_id   bigint,
  p_from_stage_name  text,
  p_to_stage_name    text,
  p_pipeline_name    text,
  p_moved_by         text,
  p_draft_id         uuid default null,
  p_actor_name       text default null,
  p_window_seconds   int  default 120,
  -- Solo completar un evento reciente que describa este mismo destino; si no hay
  -- ninguno, NO insertar (devuelve NULL). Lo usa apply_lead_position cuando la
  -- posición ya estaba aplicada (el eco llegó primero) pero quien movió el lead
  -- (agente o persona del panel) tiene que quedar en la línea de tiempo.
  p_merge_only       boolean default false
)
returns uuid language plpgsql set search_path = public, pg_temp as $$
declare
  v_last lead_stage_events%rowtype;
  v_id   uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_lead_id::text, 65));

  select * into v_last
    from lead_stage_events
   where lead_id = p_lead_id
   order by created_at desc, id
   limit 1;

  if found
     and v_last.to_stage_id = p_to_stage_id
     and (v_last.pipeline_id is null or p_to_pipeline_id is null or v_last.pipeline_id = p_to_pipeline_id)
     and v_last.created_at > now() - make_interval(secs => p_window_seconds)
  then
    -- Mismo movimiento: gana la fuente más informativa; lo ya sabido no se pisa.
    if p_moved_by = 'agente' then
      update lead_stage_events
         set moved_by = 'agente',
             draft_id = coalesce(p_draft_id, draft_id),
             from_stage_name = coalesce(from_stage_name, p_from_stage_name),
             to_stage_name = coalesce(to_stage_name, p_to_stage_name),
             pipeline_name = coalesce(pipeline_name, p_pipeline_name),
             from_pipeline_id = coalesce(from_pipeline_id, p_from_pipeline_id),
             pipeline_id = coalesce(pipeline_id, p_to_pipeline_id)
       where id = v_last.id;
    elsif p_actor_name is not null then
      update lead_stage_events
         set actor_name = coalesce(actor_name, p_actor_name),
             from_stage_name = coalesce(from_stage_name, p_from_stage_name),
             to_stage_name = coalesce(to_stage_name, p_to_stage_name),
             pipeline_name = coalesce(pipeline_name, p_pipeline_name),
             from_pipeline_id = coalesce(from_pipeline_id, p_from_pipeline_id),
             pipeline_id = coalesce(pipeline_id, p_to_pipeline_id)
       where id = v_last.id;
    else
      update lead_stage_events
         set from_pipeline_id = coalesce(from_pipeline_id, p_from_pipeline_id),
             pipeline_id = coalesce(pipeline_id, p_to_pipeline_id)
       where id = v_last.id;
    end if;
    return v_last.id;
  end if;

  if p_merge_only then
    return null;
  end if;

  insert into lead_stage_events (
    lead_id, from_stage_id, from_pipeline_id, to_stage_id, pipeline_id,
    from_stage_name, to_stage_name, pipeline_name, moved_by, draft_id, actor_name
  ) values (
    p_lead_id, p_from_stage_id, p_from_pipeline_id, p_to_stage_id, p_to_pipeline_id,
    p_from_stage_name, p_to_stage_name, p_pipeline_name, p_moved_by, p_draft_id, p_actor_name
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Interno: lo llama apply_lead_position(). Sin grant a `authenticated` (un usuario
-- no puede fabricar eventos con moved_by/actor_name a gusto).
revoke execute on function record_lead_stage_event(uuid, bigint, bigint, bigint, bigint, text, text, text, text, uuid, text, int, boolean)
  from public, anon, authenticated;
grant execute on function record_lead_stage_event(uuid, bigint, bigint, bigint, bigint, text, text, text, text, uuid, text, int, boolean)
  to service_role;

-- ÚNICO camino que escribe la posición (etapa + pipeline) de un lead: webhook de
-- Kommo, agente, panel, lectura en vivo y seguimiento. Un solo UPDATE condicional
-- bajo bloqueo de fila (select … for update): la decisión «¿es más nuevo que lo
-- guardado?» y la escritura son atómicas, no un select seguido de un update.
--
--   · 'stale'     p_at es ANTERIOR al instante ya guardado → no se toca la
--                 posición ni se crea ningún evento (un leads.status viejo que
--                 llega tarde, por otro worker o por el reaper de la cola).
--   · 'unchanged' misma etapa y pipeline → no se escribe NADA (la mayoría de los
--                 leads.update son de otros campos y cada UPDATE a `leads` dispara
--                 un refresco en vivo en los inbox abiertos). Excepciones: si estaba
--                 marcado «no existe en Kommo», la señal de vida lo borra; y si
--                 quien llama es el agente o una persona del panel, se COMPLETA el
--                 evento reciente del mismo destino (el eco de Kommo llegó antes).
--   · 'applied'   se escribió etapa + pipeline + kommo_position_at; `moved` indica
--                 si fue un movimiento real (había etapa previa) y entonces se
--                 registra el evento (record_lead_stage_event, que además une el
--                 eco con la fuente). El evento se registra SOLO si se aplicó.
--   · 'missing'   el lead no existe.
-- p_pipeline_id NULL = el webhook no trajo pipeline: no pisa el que hay.
-- p_at con resolución de segundos (last_modified de Kommo): un empate se aplica.
create or replace function apply_lead_position(
  p_lead_id        uuid,
  p_stage_id       bigint,
  p_pipeline_id    bigint,
  p_at             timestamptz,
  p_moved_by       text default 'kommo',
  p_draft_id       uuid default null,
  p_actor_name     text default null,
  p_from_stage_name text default null,
  p_to_stage_name  text default null,
  p_pipeline_name  text default null
)
returns table (
  outcome           text,
  moved             boolean,
  event_id          uuid,
  prev_stage_id     bigint,
  prev_pipeline_id  bigint
) language plpgsql set search_path = public, pg_temp as $$
declare
  l          leads%rowtype;
  v_changed  boolean;
  v_pipeline bigint;
  v_moved    boolean := false;
  v_event    uuid;
begin
  select * into l from leads where id = p_lead_id for update;
  if not found then
    return query select 'missing'::text, false, null::uuid, null::bigint, null::bigint;
    return;
  end if;

  if l.kommo_position_at is not null and p_at < l.kommo_position_at then
    -- Evento viejo: no cambia la posición, pero sigue siendo señal de vida.
    if l.kommo_missing_at is not null then
      update leads set kommo_missing_at = null where id = l.id;
    end if;
    v_event := null;
    if p_moved_by = 'agente' or p_actor_name is not null then
      v_event := record_lead_stage_event(
        l.id, l.kommo_stage_id, l.kommo_pipeline_id, p_stage_id, coalesce(p_pipeline_id, l.kommo_pipeline_id),
        p_from_stage_name, p_to_stage_name, p_pipeline_name, p_moved_by, p_draft_id, p_actor_name, 120, true
      );
    end if;
    return query select 'stale'::text, false, v_event, l.kommo_stage_id, l.kommo_pipeline_id;
    return;
  end if;

  v_pipeline := coalesce(p_pipeline_id, l.kommo_pipeline_id);
  v_changed  := l.kommo_stage_id is distinct from p_stage_id
                or l.kommo_pipeline_id is distinct from v_pipeline;

  if not v_changed then
    if l.kommo_missing_at is not null then
      update leads set kommo_missing_at = null where id = l.id;
    end if;
    -- El eco de Kommo pudo llegar ANTES que el agente/panel: el evento ya existe
    -- (anónimo, «movido en Kommo»); se completa con quien lo movió.
    v_event := null;
    if p_moved_by = 'agente' or p_actor_name is not null then
      v_event := record_lead_stage_event(
        l.id, l.kommo_stage_id, l.kommo_pipeline_id, p_stage_id, v_pipeline,
        p_from_stage_name, p_to_stage_name, p_pipeline_name, p_moved_by, p_draft_id, p_actor_name, 120, true
      );
    end if;
    return query select 'unchanged'::text, false, v_event, l.kommo_stage_id, l.kommo_pipeline_id;
    return;
  end if;

  update leads
     set kommo_stage_id    = p_stage_id,
         kommo_pipeline_id = v_pipeline,
         kommo_position_at = p_at,
         kommo_missing_at  = null
   where id = l.id;

  -- Movimiento real solo si ya había etapa (null → etapa = primera vez que la
  -- vemos), y cambiar de pipeline conservando el id de etapa también cuenta
  -- (142/143 existen en todos los pipelines).
  v_moved := l.kommo_stage_id is not null
             and (l.kommo_stage_id <> p_stage_id
                  or (l.kommo_pipeline_id is not null and l.kommo_pipeline_id <> v_pipeline));
  if v_moved then
    v_event := record_lead_stage_event(
      l.id, l.kommo_stage_id, l.kommo_pipeline_id, p_stage_id, v_pipeline,
      p_from_stage_name, p_to_stage_name, p_pipeline_name, p_moved_by, p_draft_id, p_actor_name, 120, false
    );
  end if;
  return query select 'applied'::text, v_moved, v_event, l.kommo_stage_id, l.kommo_pipeline_id;
end;
$$;

-- Solo service_role: el panel llama a través de rutas del servidor que ya validaron
-- sesión y alcance; un usuario con la anon key + su JWT no puede fijar posiciones
-- ni fabricar eventos.
revoke execute on function apply_lead_position(uuid, bigint, bigint, timestamptz, text, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function apply_lead_position(uuid, bigint, bigint, timestamptz, text, uuid, text, text, text, text)
  to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lead_stage_events'
     ) then
    alter publication supabase_realtime add table lead_stage_events;
  end if;
end $$;

-- ── 4) Resumen por lead para el inbox ────────────────────────────────────────
-- Misma lógica que calculaba el inbox en JS:
--   · solo leads con al menos un mensaje;
--   · urgency/toxicity llegan como texto en classification y pueden no ser
--     números → conversión tolerante (lo no numérico cuenta como 0);
--   · awaiting_reply: `messages` guarda lo que escribe el lead (los mensajes
--     salientes de Kommo no llegan por webhook) y las respuestas del agente
--     viven en `drafts`. "El último mensaje es inbound" daba TODAS las
--     conversaciones; "sin responder" = el lead escribió DESPUÉS de la última
--     respuesta enviada, ese mensaje no se silenció a propósito (ignored:
--     etapa pausada, agente apagado… atiende una persona desde Kommo) y el
--     agente no lo tomó todavía (answered_by_draft_id nulo);
--   · last_content / last_direction = lo más reciente entre el último mensaje
--     del lead y la última respuesta enviada.
-- DROP porque cambia el tipo de retorno (se agregó kommo_missing_at).
drop function if exists inbox_lead_summaries();
create function inbox_lead_summaries()
returns table (
  id                   uuid,
  display_name         text,
  channel              text,
  kommo_lead_id        bigint,
  kommo_pipeline_id    bigint,
  kommo_stage_id       bigint,
  kommo_missing_at     timestamptz,
  last_message_at      timestamptz,
  msg_count            int,
  last_content         text,
  last_direction       text,
  last_created_at      timestamptz,
  last_vertical        text,
  has_review_pending   boolean,
  max_urgency          numeric,
  max_toxicity         numeric,
  verticals            text[],
  awaiting_reply       boolean,
  last_reply_at        timestamptz
) language sql stable set search_path = public, pg_temp as $$
  with agg as (
    select m.lead_id,
           count(*)::int as msg_count,
           coalesce(max(case when m.classification->>'urgency' ~ '^-?[0-9]+(\.[0-9]+)?$'
                             then (m.classification->>'urgency')::numeric end), 0) as max_urgency,
           coalesce(max(case when m.classification->>'toxicity' ~ '^-?[0-9]+(\.[0-9]+)?$'
                             then (m.classification->>'toxicity')::numeric end), 0) as max_toxicity,
           bool_or(m.direction = 'inbound' and m.requires_human_review) as has_review_pending,
           array_remove(array_agg(distinct v.slug), null) as verticals
      from messages m
      left join verticals v on v.id = m.vertical_id
     group by m.lead_id
  )
  -- Lookups por índice (messages_lead_id_idx, drafts_message_idx): uno por lead.
  select l.id, l.display_name, l.channel, l.kommo_lead_id, l.kommo_pipeline_id, l.kommo_stage_id,
         l.kommo_missing_at,
         l.last_message_at,
         a.msg_count,
         case when r.sent_at > lm.created_at then left(r.body, 300) else lm.content end,
         case when r.sent_at > lm.created_at then 'outbound' else lm.direction end,
         greatest(lm.created_at, r.sent_at),
         lm.vertical,
         coalesce(a.has_review_pending, false), a.max_urgency, a.max_toxicity, a.verticals,
         coalesce(
           li.created_at is not null
           and (r.sent_at is null or li.created_at > r.sent_at)
           and not coalesce(li.ignored, false)
           and li.answered_by_draft_id is null,
           false),
         r.sent_at
    from leads l
    join agg a on a.lead_id = l.id
    cross join lateral (
      select left(m.content, 300) as content, m.direction, m.created_at, v.slug as vertical
        from messages m
        left join verticals v on v.id = m.vertical_id
       where m.lead_id = l.id
       order by m.created_at desc, m.id
       limit 1
    ) lm
    left join lateral (
      select m.ignored, m.created_at, m.answered_by_draft_id
        from messages m
       where m.lead_id = l.id and m.direction = 'inbound'
       order by m.created_at desc, m.id
       limit 1
    ) li on true
    left join lateral (
      select d.sent_at, coalesce(d.edited_body, d.body) as body
        from drafts d
        join messages m on m.id = d.message_id
       where m.lead_id = l.id and d.sent_at is not null and d.status in ('sent', 'auto_sent')
       order by d.sent_at desc
       limit 1
    ) r on true
$$;

revoke execute on function inbox_lead_summaries() from public, anon;
grant execute on function inbox_lead_summaries() to authenticated, service_role;

-- ── 5) Backfill de pipeline/etapa de los leads existentes ────────────────────
create table if not exists kommo_backfill (
  job         text primary key,
  status      text not null default 'pending'
                check (status in ('pending', 'running', 'done', 'failed')),
  next_page   int not null default 1,
  scanned     int not null default 0,
  updated     int not null default 0,
  lease_until timestamptz,
  last_error  text,
  started_at  timestamptz,
  finished_at timestamptz,
  updated_at  timestamptz not null default now()
);

alter table kommo_backfill enable row level security;
drop policy if exists kommo_backfill_read on kommo_backfill;
create policy kommo_backfill_read on kommo_backfill for select to authenticated using (true);
revoke all on kommo_backfill from anon;
revoke insert, update, delete, truncate on kommo_backfill from authenticated;

-- ON CONFLICT DO NOTHING: re-aplicar la migración nunca reinicia un backfill.
insert into kommo_backfill (job) values ('lead_positions') on conflict (job) do nothing;

-- Estado compartido de los frenos entre instancias (hoy: último refresco de
-- pipelines). Una variable en memoria de la Edge Function no frena nada cuando
-- hay varias instancias; esta fila sí.
create table if not exists kommo_sync_state (
  clave   text primary key,
  last_at timestamptz not null default 'epoch'
);
alter table kommo_sync_state enable row level security;
revoke all on kommo_sync_state from anon, authenticated, public;

-- Hojas «vistas» por el recorrido en curso: el insumo para saber qué leads
-- locales NO existen en Kommo. Se vacía al empezar un recorrido (página 1).
create table if not exists kommo_backfill_seen (
  kommo_lead_id bigint primary key
);
alter table kommo_backfill_seen enable row level security;
revoke all on kommo_backfill_seen from anon, authenticated, public;

-- Freno atómico del refresco de pipelines: devuelve true si le toca refrescar
-- a QUIEN LLAMA (y deja registrado el instante), false si otro lo hizo hace
-- menos de p_min_interval_seconds. Un único UPDATE/INSERT condicional: dos
-- instancias simultáneas no pueden ganar las dos.
create or replace function claim_kommo_pipelines_refresh(p_min_interval_seconds int default 30)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare
  v_won boolean;
begin
  with c as (
    insert into kommo_sync_state (clave, last_at) values ('pipelines_refresh', now())
    on conflict (clave) do update set last_at = now()
      where kommo_sync_state.last_at < now() - make_interval(secs => p_min_interval_seconds)
    returning 1
  )
  select exists (select 1 from c) into v_won;
  return v_won;
end;
$$;

revoke execute on function claim_kommo_pipelines_refresh(int) from public, anon, authenticated;
grant execute on function claim_kommo_pipelines_refresh(int) to service_role;

-- Reclamo atómico con lease. La BASE decide, sin importar quién llama:
--   · lease vigente (otro worker corriendo)            → 'busy', no se toca nada.
--   · 'pending'/'running'/'failed' sin lease           → 'claimed': CONTINÚA desde
--     el cursor guardado. Un pedido de reinicio NUNCA lo rebobina, tampoco con
--     'failed': un 'failed' se retoma tal cual, sin enfriamiento.
--   · 'done' + p_restart + enfriamiento cumplido       → 'restarted' (página 1).
--   · 'done' + p_restart + dentro del enfriamiento     → 'cooldown' + retry_after.
--   · 'done' sin pedido                                → 'done' (nada que hacer).
-- Los leads que nacieron después de un recorrido NO reabren el recorrido: se
-- completan por id (kommo_gap_lead_ids), sin recorrer todo Kommo.
-- p_cooldown_seconds se mide desde el último movimiento del recorrido
-- (updated_at: lo toca el claim y cada página guardada).
-- DROP: cambia la firma respecto de las versiones anteriores.
drop function if exists claim_kommo_backfill(text, int, boolean);
drop function if exists claim_kommo_backfill(text, int, boolean, int, boolean, int);
create or replace function claim_kommo_backfill(
  p_job text,
  p_lease_seconds int default 150,
  p_restart boolean default false,
  p_cooldown_seconds int default 900
)
returns table (
  outcome             text,
  status              text,
  next_page           int,
  scanned             int,
  updated             int,
  retry_after_seconds int
) language plpgsql set search_path = public, pg_temp as $$
declare
  b          kommo_backfill%rowtype;
  v_restart  boolean := false;
  v_wait     int;
begin
  select * into b from kommo_backfill k where k.job = p_job for update;
  if not found then
    return query select 'missing'::text, null::text, null::int, null::int, null::int, null::int;
    return;
  end if;

  if b.lease_until is not null and b.lease_until > now() then
    return query select 'busy'::text, b.status, b.next_page, b.scanned, b.updated, null::int;
    return;
  end if;

  v_wait := greatest(0, ceil(extract(epoch from (b.updated_at + make_interval(secs => p_cooldown_seconds) - now()))))::int;

  if b.status = 'done' then
    if not p_restart then
      return query select 'done'::text, b.status, b.next_page, b.scanned, b.updated, null::int;
      return;
    end if;
    if v_wait > 0 then
      return query select 'cooldown'::text, b.status, b.next_page, b.scanned, b.updated, v_wait;
      return;
    end if;
    v_restart := true;
  end if;

  update kommo_backfill k
     set status      = 'running',
         lease_until = now() + make_interval(secs => p_lease_seconds),
         next_page   = case when v_restart then 1 else k.next_page end,
         scanned     = case when v_restart then 0 else k.scanned end,
         updated     = case when v_restart then 0 else k.updated end,
         started_at  = case when v_restart or k.started_at is null then now() else k.started_at end,
         finished_at = null,
         last_error  = null,
         updated_at  = now()
   where k.job = p_job
  returning * into b;

  -- Recorrido nuevo: lo «visto» del anterior no vale.
  if b.next_page = 1 then
    delete from kommo_backfill_seen where true;
  end if;

  return query select case when v_restart then 'restarted' else 'claimed' end,
                      b.status, b.next_page, b.scanned, b.updated, null::int;
end;
$$;

revoke execute on function claim_kommo_backfill(text, int, boolean, int) from public, anon, authenticated;
grant execute on function claim_kommo_backfill(text, int, boolean, int) to service_role;

-- Aplica la posición (pipeline + etapa) que Kommo informa para cada lead.
-- p_leads: [{id, pipeline_id, status_id}], leído de Kommo en p_read_at (el instante
-- en que se PIDIÓ la página). Respeta el orden de eventos: no pisa una posición
-- cuyo kommo_position_at sea posterior a la lectura (un webhook más nuevo ya la
-- fijó). Solo toca filas que CAMBIAN (cada UPDATE a `leads` dispara un refresco en
-- vivo en todos los inbox abiertos) y NO escribe lead_stage_events: reconciliar no
-- es un movimiento. Anota cada id visto (kommo_backfill_seen) y limpia
-- kommo_missing_at de los leads que Kommo sí devuelve. Devuelve cuántos cambió.
drop function if exists apply_kommo_lead_positions(jsonb);
-- NÚCLEO ÚNICO de escritura masiva de posición (SuperCines, desvío respecto del
-- template, que lo tiene todo dentro de apply_kommo_lead_positions): dos llamadores
-- lo comparten — el backfill de sync-pipelines (p_track_seen = true: cada hoja vista
-- alimenta la detección de leads borrados en Kommo) y la reconciliación que hace
-- kommo-funnel-sync con la lectura que YA tiene de las 3 sedes (p_track_seen = false:
-- una ventana de 35 días de tres pipelines NO es un recorrido completo y no puede
-- alimentar «no existe en Kommo»). Misma regla de orden por kommo_position_at, un
-- solo lugar donde cambia.
create or replace function apply_positions_batch(p_leads jsonb, p_read_at timestamptz, p_track_seen boolean)
returns int language plpgsql set search_path = public, pg_temp as $$
declare
  v_updated int;
begin
  if p_leads is null or jsonb_typeof(p_leads) <> 'array' or jsonb_array_length(p_leads) = 0 then
    return 0;
  end if;

  if p_track_seen then
    insert into kommo_backfill_seen (kommo_lead_id)
    select distinct (e->>'id')::bigint
      from jsonb_array_elements(p_leads) e
     where e->>'id' is not null
    on conflict do nothing;
  end if;

  with src as (
    select (e->>'id')::bigint as kommo_lead_id,
           (e->>'pipeline_id')::bigint as pipeline_id,
           (e->>'status_id')::bigint as status_id
      from jsonb_array_elements(p_leads) e
     where e->>'id' is not null and e->>'pipeline_id' is not null and e->>'status_id' is not null
  ),
  upd as (
    update leads l
       set kommo_pipeline_id = s.pipeline_id,
           kommo_stage_id    = s.status_id,
           kommo_position_at = p_read_at,
           kommo_missing_at  = null
      from src s
     where l.kommo_lead_id = s.kommo_lead_id
       and (l.kommo_position_at is null or l.kommo_position_at <= p_read_at)
       and (l.kommo_pipeline_id is distinct from s.pipeline_id
            or l.kommo_stage_id is distinct from s.status_id
            or l.kommo_missing_at is not null)
    returning 1
  )
  select count(*)::int into v_updated from upd;
  return v_updated;
end;
$$;

-- Candidatos a «no existe en Kommo» al cerrar un recorrido COMPLETO: leads locales
-- con id de Kommo que el recorrido no vio. NO son todavía inexistentes: las páginas
-- (page=N) se corren si borran un lead durante la lectura y un lead vivo puede
-- saltarse. El caller los verifica por id en Kommo y solo marca los confirmados
-- ausentes (mark_kommo_leads_missing). Salvaguardas: sin ninguna hoja vista no hay
-- candidatos (una respuesta vacía/rara de Kommo no puede cuestionar toda la base);
-- solo leads creados antes de empezar el recorrido y sin señal de vida posterior
-- (kommo_position_at); los ya marcados no vuelven a ser candidatos.
create or replace function kommo_missing_candidates(p_job text, p_limit int default 5000)
returns setof bigint language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_started timestamptz;
begin
  select started_at into v_started from kommo_backfill where job = p_job;
  if v_started is null or not exists (select 1 from kommo_backfill_seen) then
    return;
  end if;
  return query
    select l.kommo_lead_id
      from leads l
     where l.kommo_lead_id is not null
       and l.kommo_missing_at is null
       and l.created_at < v_started
       and (l.kommo_position_at is null or l.kommo_position_at < v_started)
       and not exists (select 1 from kommo_backfill_seen s where s.kommo_lead_id = l.kommo_lead_id)
     order by l.kommo_lead_id
     limit p_limit;
end;
$$;

-- Leads sin pipeline que Kommo todavía no confirmó como inexistentes: los que
-- nacieron después del recorrido (el webhook de su alta no traía pipeline). El
-- caller pide a Kommo SOLO estos ids (lotes de filter[id][]).
create or replace function kommo_gap_lead_ids(p_limit int default 200)
returns setof bigint language sql stable set search_path = public, pg_temp as $$
  select l.kommo_lead_id
    from leads l
   where l.kommo_lead_id is not null
     and l.kommo_pipeline_id is null
     and l.kommo_missing_at is null
   order by l.last_message_at desc nulls last, l.kommo_lead_id
   limit p_limit
$$;

-- Marca los ids que Kommo CONFIRMÓ ausentes.
create or replace function mark_kommo_leads_missing(p_ids bigint[])
returns int language plpgsql set search_path = public, pg_temp as $$
declare
  v_marked int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  with m as (
    update leads l
       set kommo_missing_at = now()
     where l.kommo_lead_id = any(p_ids)
       and l.kommo_missing_at is null
    returning 1
  )
  select count(*)::int into v_marked from m;
  return v_marked;
end;
$$;

revoke execute on function apply_positions_batch(jsonb, timestamptz, boolean) from public, anon, authenticated;
grant execute on function apply_positions_batch(jsonb, timestamptz, boolean) to service_role;

create or replace function apply_kommo_lead_positions(p_leads jsonb, p_read_at timestamptz default now())
returns int language sql set search_path = public, pg_temp as $$
  select apply_positions_batch(p_leads, p_read_at, true);
$$;
revoke execute on function apply_kommo_lead_positions(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function apply_kommo_lead_positions(jsonb, timestamptz) to service_role;
revoke execute on function kommo_missing_candidates(text, int) from public, anon, authenticated;
grant execute on function kommo_missing_candidates(text, int) to service_role;
revoke execute on function kommo_gap_lead_ids(int) from public, anon, authenticated;
grant execute on function kommo_gap_lead_ids(int) to service_role;
revoke execute on function mark_kommo_leads_missing(bigint[]) from public, anon, authenticated;
grant execute on function mark_kommo_leads_missing(bigint[]) to service_role;
drop function if exists mark_kommo_missing_leads(text);

-- Secreto interno de bajo privilegio para las Edge Functions verify_jwt=false que
-- no son webhooks externos (estándar de seguridad de Boosty: nada de service_role
-- en cron, nada hardcodeado). Se GENERA acá, por despliegue, y nunca viaja en el
-- repo: ON CONFLICT DO NOTHING hace que re-aplicar no lo rote. Sin policies y con
-- REVOKE a anon/authenticated: solo lo leen service_role (la Edge Function, que lo
-- compara con el header x-internal-secret) y las funciones SECURITY DEFINER que
-- arman la llamada (trigger_sync_pipelines, abajo). Rotarlo = UPDATE de esta fila.
create table if not exists _app_secrets (
  clave text primary key,
  valor text not null
);
alter table _app_secrets enable row level security;
revoke all on _app_secrets from anon, authenticated, public;

insert into _app_secrets (clave, valor)
values ('INTERNAL_FUNCTION_SECRET', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (clave) do nothing;

-- Headers para que pg_cron (vía pg_net) llame a una Edge Function interna: el
-- secreto sale de _app_secrets, nunca del SQL ni del repo. SECURITY DEFINER porque
-- el cron corre con un rol que no lee la tabla; sin ningún EXECUTE para nadie más
-- (anon/authenticated/public no pueden pedir el secreto por RPC). Si el secreto no
-- existe devuelve los headers sin él (la función destino responderá 401).
create or replace function internal_function_headers()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_secret text;
begin
  select valor into v_secret from _app_secrets where clave = 'INTERNAL_FUNCTION_SECRET';
  if v_secret is null then
    raise warning 'internal_function_headers: falta INTERNAL_FUNCTION_SECRET en _app_secrets';
    return jsonb_build_object('Content-Type', 'application/json');
  end if;
  return jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret);
end;
$$;

revoke execute on function internal_function_headers() from public, anon, authenticated;

-- Cron: refresca pipelines y avanza el backfill. La Edge Function tiene
-- verify_jwt = false pero exige x-internal-secret (gate en _shared/auth.ts).
-- Sin Kommo configurado responde 200 "skipped" y vuelve a intentar en 10 min.
create or replace function trigger_sync_pipelines()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/sync-pipelines',
    headers := internal_function_headers(),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

revoke execute on function trigger_sync_pipelines() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'sync-pipelines') then
    perform cron.schedule(
      'sync-pipelines',
      '*/10 * * * *',
      $cron$select trigger_sync_pipelines();$cron$
    );
  end if;
end$$;
