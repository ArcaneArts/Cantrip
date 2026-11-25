CREATE TABLE council_history_state (
  chat_id text PRIMARY KEY REFERENCES council_agents(chat_id) ON DELETE CASCADE,
  revision bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE council_history_changes (
  chat_id text NOT NULL REFERENCES council_history_state(chat_id) ON DELETE CASCADE,
  message_id text NOT NULL,
  sequence bigint NOT NULL,
  revision bigint NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
--> statement-breakpoint
CREATE INDEX council_history_changes_cursor ON council_history_changes(chat_id, revision, sequence);
--> statement-breakpoint
CREATE FUNCTION invalidate_council_history_after_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH changed AS MATERIALIZED (
    SELECT previous.chat_id, previous.id, previous.sequence
    FROM old_messages previous JOIN new_messages current_row ON current_row.id = previous.id
    JOIN council_agents a ON a.chat_id = previous.chat_id
    WHERE (previous.protected_content, previous.attachment_ids, previous.role, previous.mode, previous.created_at, previous.sequence)
      IS DISTINCT FROM
      (current_row.protected_content, current_row.attachment_ids, current_row.role, current_row.mode, current_row.created_at, current_row.sequence)
  ), bumped AS (
    INSERT INTO council_history_state (chat_id, revision) SELECT DISTINCT chat_id, 1 FROM changed
    ON CONFLICT (chat_id) DO UPDATE SET revision = council_history_state.revision + 1
    RETURNING chat_id, revision
  )
  INSERT INTO council_history_changes (chat_id, message_id, sequence, revision)
  SELECT c.chat_id, c.id, c.sequence, b.revision FROM changed c JOIN bumped b USING(chat_id)
  ON CONFLICT (chat_id, message_id) DO UPDATE SET revision = EXCLUDED.revision;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION invalidate_council_history_after_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH changed AS MATERIALIZED (
    SELECT m.chat_id, m.id, m.sequence FROM deleted_messages m JOIN council_agents a ON a.chat_id = m.chat_id
  ), bumped AS (
    INSERT INTO council_history_state (chat_id, revision) SELECT DISTINCT chat_id, 1 FROM changed
    ON CONFLICT (chat_id) DO UPDATE SET revision = council_history_state.revision + 1
    RETURNING chat_id, revision
  )
  INSERT INTO council_history_changes (chat_id, message_id, sequence, revision)
  SELECT c.chat_id, c.id, c.sequence, b.revision FROM changed c JOIN bumped b USING(chat_id)
  ON CONFLICT (chat_id, message_id) DO UPDATE SET revision = EXCLUDED.revision;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER council_history_message_update AFTER UPDATE ON chat_messages
REFERENCING OLD TABLE AS old_messages NEW TABLE AS new_messages
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_council_history_after_update();
--> statement-breakpoint
CREATE TRIGGER council_history_message_delete AFTER DELETE ON chat_messages
REFERENCING OLD TABLE AS deleted_messages
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_council_history_after_delete();
