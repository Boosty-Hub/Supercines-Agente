-- 0089 — Un draft sin texto no puede aprobarse ni enviarse (guarda en la base).
--
-- Un «no responder» del agente (0087/0088) deja drafts con body = '' (skipped, o pending en
-- revisión). Desde 0088 el panel puede aprobar un skipped («responder igual»): la ruta
-- approve exige texto y publish-to-kommo lo bloquea igual (outbound.ts: «texto vacío»),
-- pero la sesión del panel también puede escribir drafts por PostgREST directo (policy
-- drafts_review). Esta restricción cierra el último camino: ningún draft llega a
-- approved/publishing/sent/auto_sent sin texto.
--
-- «Texto» = la misma regla que draftText() + String.trim() de JS: edited_body o body con
-- algún carácter que no sea espacio, con EXACTAMENTE la clase de String.trim(): \t \n \v \f
-- \r, espacio y los espacios Unicode (U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
-- U+205F, U+3000, U+FEFF). No [[:space:]]: en la imagen de Supabase incluye además
-- U+001C–U+001F y U+0085, que trim() no quita.

-- 1) Saneo previo: un approved/publishing viejo sin texto (posible antes de esta versión:
--    la ruta approve no exigía texto) trabaría la cola de publicación — con la restricción,
--    reservarlo (approved → publishing) fallaría en cada corrida y, por ir primero por
--    antigüedad, ningún draft más nuevo saldría. Vuelve a revisión humana con el motivo.
update drafts
   set status = 'pending',
       publish_owner = null,
       publish_lease_until = null,
       publish_claimed_at = null,
       publish_attempts = 0,
       agent_metadata = coalesce(agent_metadata, '{}'::jsonb)
         || jsonb_build_object('guard_blocked', true, 'guard_reason', 'texto vacío', 'guard_stage', '0089')
 where status in ('approved', 'publishing')
   and regexp_replace(coalesce(edited_body, ''), '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]', '', 'g') = ''
   and regexp_replace(coalesce(body, ''), '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]', '', 'g') = '';

-- 2) La restricción.
alter table drafts drop constraint if exists drafts_texto_para_enviar;
alter table drafts add constraint drafts_texto_para_enviar
  check (status not in ('approved', 'publishing', 'sent', 'auto_sent')
         or regexp_replace(coalesce(edited_body, ''), '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]', '', 'g') <> ''
         or regexp_replace(coalesce(body, ''), '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]', '', 'g') <> '')
  not valid;

-- 3) Validar. Solo puede quedar algún sent/auto_sent histórico sin texto (no se reescribe
--    historia): en ese caso rige para toda escritura nueva y se avisa. Esas filas no las
--    vuelve a escribir ningún flujo (la reserva de publicación solo toma approved).
do $$
begin
  alter table drafts validate constraint drafts_texto_para_enviar;
exception when check_violation then
  raise notice 'drafts_texto_para_enviar: hay drafts enviados históricos sin texto; la restricción rige para escrituras nuevas';
end $$;
