-- =============================================================
-- 0014_message_batching.sql
-- Permite que un solo draft cubra varios mensajes inbound del
-- mismo lead (debounce + batching de mensajes fragmentados).
-- Un mensaje se considera "respondido" si tiene draft propio
-- O si answered_by_draft_id apunta a un draft que lo cubre.
-- =============================================================

alter table messages
  add column if not exists answered_by_draft_id uuid
  references drafts(id) on delete set null;

create index if not exists messages_answered_by_draft_idx
  on messages(answered_by_draft_id)
  where answered_by_draft_id is not null;

-- Índice para el barrido de candidatos: inbound, clasificado, sin responder.
create index if not exists messages_pending_response_idx
  on messages(lead_id, created_at)
  where direction = 'inbound'
    and requires_human_review = false
    and answered_by_draft_id is null;
