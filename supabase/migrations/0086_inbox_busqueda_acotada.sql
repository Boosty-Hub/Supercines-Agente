-- =============================================================
-- 0086_inbox_busqueda_acotada.sql
-- Defensa en profundidad del inbox paginado (0085): el término de búsqueda se acota a
-- 200 caracteres TAMBIÉN en la base (la web ya lo cortaba; la RPC se puede llamar directo
-- con la sesión). La búsqueda ya era literal (strpos, sin LIKE ni regex): ningún texto del
-- usuario se evalúa como patrón, así que no hay backtracking posible. Misma firma y mismos
-- permisos que en 0085. IDEMPOTENTE.
-- =============================================================

create or replace function inbox_filter_sql(p_filters jsonb)
returns text language plpgsql immutable set search_path = public, pg_temp as $$
declare
  f jsonb := case when jsonb_typeof(p_filters) = 'object' then p_filters else '{}'::jsonb end;
  -- Búsqueda LITERAL (strpos, nunca LIKE/regex: el texto del usuario no es un patrón) y
  -- acotada a 200 caracteres también acá, por si alguien llama la RPC directo.
  v_q text := nullif(left(btrim(coalesce(f->>'q', '')), 200), '');
  v_channel text := nullif(f->>'channel', '');
  v_vertical text := nullif(f->>'vertical', '');
  v_estado text := nullif(f->>'estado', '');
  v_rango text := nullif(f->>'rango', '');
  out text := '';
begin
  if v_q is not null then
    out := out || format(
      ' and strpos(lower(coalesce(l.display_name, '''') || '' '' || coalesce(l.kommo_lead_id::text, '''') || '' '' || coalesce(s.last_content, '''')), lower(%L)) > 0',
      v_q);
  end if;
  if v_channel is not null then
    -- Misma normalización que normChannel() (web/src/lib/inbox-data.ts).
    out := out || format(
      ' and (case when lower(coalesce(l.channel, '''')) like ''%%whatsapp%%'' or lower(l.channel) = ''waba'' then ''whatsapp'''
      ' when lower(coalesce(l.channel, '''')) like ''%%instagram%%'' then ''instagram'''
      ' when lower(coalesce(l.channel, '''')) like ''%%facebook%%'' or lower(l.channel) = ''fb'' then ''facebook'''
      ' when lower(coalesce(l.channel, '''')) like ''%%tiktok%%'' then ''tiktok'''
      ' when lower(coalesce(l.channel, '''')) like ''%%telegram%%'' then ''telegram'''
      ' else ''other'' end) = %L',
      v_channel);
  end if;
  if v_vertical is not null then
    out := out || format(' and %L = any (s.verticals)', v_vertical);
  end if;
  if coalesce(f->>'urgent', '') in ('true', '1') then
    out := out || ' and s.max_urgency >= 4';
  end if;
  out := out || case f->>'etapa'
    when 'agente' then ' and ' || inbox_etapa_agente_sql()
    when 'apagadas' then ' and not ' || inbox_etapa_agente_sql()
    else '' end;
  out := out || case v_estado
    when 'review'   then ' and s.has_review_pending'
    when 'waiting'  then ' and s.awaiting_reply'
    when 'answered' then ' and s.last_reply_at is not null'
    when 'toxic'    then ' and s.max_toxicity > 0.3'
    else '' end;
  out := out || case v_rango
    when '1h'    then ' and l.last_message_at >= now() - interval ''1 hour'''
    when 'today' then ' and l.last_message_at >= now() - interval ''24 hours'''
    when '7d'    then ' and l.last_message_at >= now() - interval ''7 days'''
    when '30d'   then ' and l.last_message_at >= now() - interval ''30 days'''
    else '' end;
  return out;
end $$;
