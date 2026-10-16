-- 0087 — drafts.status `skipped`: el agente decidió NO responder a propósito.
--
-- Antes, cuando el system prompt o los aprendizajes del operador decían «si el lead
-- manda solo emojis / una reacción / spam, no respondas», el agente cerraba con un
-- bloque <respuesta> vacío y generate-response lo marcaba `failed` («agent devolvió
-- respuesta vacía»): alerta draft_failed por webhook por algo que no era una falla.
-- Ahora el agente declara <sin_respuesta>motivo</sin_respuesta> y el draft queda
-- `skipped` (terminal: no se publica, no alerta, el lote queda cubierto). El motivo
-- y el session_id quedan en agent_metadata.
--
-- Orden de deploy: esta migración ANTES que la generate-response nueva (si no, el
-- UPDATE a `skipped` viola el CHECK, el draft queda `pending` y el barrido de runs
-- muertos lo borra y reprocesa el lote).
alter table drafts drop constraint if exists drafts_status_check;
alter table drafts add constraint drafts_status_check
  check (status in ('pending', 'approved', 'publishing', 'sent', 'rejected', 'auto_sent', 'failed', 'skipped'));
